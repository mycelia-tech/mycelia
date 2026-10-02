import { dirname, join } from "node:path";
import { loadBackupConfig } from "./config.ts";
import { buildSourceManifest, reconcileSourcePaths } from "./sources.ts";
import type {
  ManifestOptions,
  ProtectedConfig,
  VoiceMemosMapping,
} from "./sources.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function write(path: string, text = "original") {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text);
}
async function git(root: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    args: ["-C", root, ...args],
    clearEnv: true,
    env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(result.success);
}
async function fixture(
  fn: (root: string, options: ManifestOptions) => Promise<void>,
) {
  const temporary = await Deno.makeTempDir();
  const root = await Deno.realPath(temporary);
  try {
    await git(root, "init", "-q");
    await write(join(root, ".env"), "");
    await Deno.mkdir(join(root, "archive"));
    const fixtureOptions = {
      archiveRoot: join(root, "archive"),
      picturesImportRoot: join(root, "optional-import"),
      runtimeRoots: {
        mongo: { kind: "named-volume" as const },
        redis: { kind: "named-volume" as const },
        rag: { active: false as const },
      },
    };
    await fn(root, fixtureOptions);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
const claims = (...paths: string[]) => ({
  filteredCount: paths.length,
  records: paths.map((path, index) => ({ _id: String(index), path })),
});

Deno.test("manifest takes tracked and explicitly reviewed files, media and optional imports; deduplicates canonical aliases", async () => {
  await fixture(async (root, options) => {
    await write(join(root, "tracked.ts"));
    await git(root, "add", "tracked.ts");
    await write(join(root, "reviewed.json"));
    await write(join(root, "unreviewed-secret"));
    await write(
      join(root, ".env.backup"),
      'BACKUP_OPERATIONAL_UNTRACKED_JSON=["reviewed.json","alias.json"]\n',
    );
    await Deno.symlink(join(root, "reviewed.json"), join(root, "alias.json"));
    await write(join(root, "media", "original.m4a"));
    await write(join(root, "archive", "memo.m4a"));
    await write(join(root, "optional-import", "photo.jpg"));
    await write(join(root, ".env"), `MEDIA_SOURCE_HOST_PATH=${root}/media\n`);
    const result = await buildSourceManifest(
      await loadBackupConfig(root, root),
      "backup-test",
      options,
    );
    assert(result.coverage.complete);
    assert(
      JSON.stringify(result.files) === JSON.stringify(
        [
          ".env",
          "archive/memo.m4a",
          "media/original.m4a",
          "optional-import/photo.jpg",
          "reviewed.json",
          "tracked.ts",
        ].map((path) => join(root, path)).sort(),
      ),
    );
    const checked = await reconcileSourcePaths(
      result,
      claims(
        join(root, "media", "original.m4a"),
        join(root, "unreviewed-secret"),
      ),
    );
    assert(
      !checked.coverage.complete && checked.coverage.covered === 1 &&
        checked.coverage.outsideRoots === 1,
    );
  });
});

Deno.test("manifest excludes dependency, database, model, test, backup and staging copies even when tracked or allowlisted", async () => {
  await fixture(async (root, options) => {
    const denied = [
      "node_modules/a",
      "dist/a",
      "build/a",
      ".cache/a",
      "__pycache__/a",
      "qdrant_storage/a",
      "redis_data/a",
      "mongo_data/a",
      "models/a",
      "test-data/a.wav",
      "test_data/a.wav",
      "tests/fixtures/a.mp3",
      ".env.backup-old",
      ".local/backup/a",
    ].map((path) => "media/" + path);
    for (const path of denied) await write(join(root, path));
    await git(root, "add", "-f", ...denied);
    await write(
      join(root, "Library/mycelia/voice-memos-staging/audio-original/memo.m4a"),
    );
    const config = await loadBackupConfig(root, root);
    config.mediaSourceHostPath = join(root, "media");
    config.operationalUntracked = [
      ...denied,
      ".git/config",
      "Library/mycelia/voice-memos-staging/audio-original/memo.m4a",
    ];
    const result = await buildSourceManifest(config, "backup-test", options);
    assert(result.coverage.complete);
    assert(result.files.length === 1 && result.files[0] === join(root, ".env"));
  });
});

Deno.test("each active protected configuration is required; inactive optional deployments are not", async () => {
  const slots: Array<
    (path: string | undefined, active: boolean) => ProtectedConfig
  > = [
    (path, active) => ({ media: { active, path } }),
    (path, active) => ({ rag: { active, path } }),
    (path, active) => ({
      tls: { active, certificate: path, privateKey: path },
    }),
    (path, active) => ({ rclone: { active, config: path, knownHosts: path } }),
    (path, active) => ({ provider: { active, path } }),
    (path, active) => ({ mongoKeyfile: { active, path } }),
    (path, active) => ({ pbm: { active, env: path, ca: path } }),
    (path, active) => ({ icloudArchive: { active, path } }),
  ];
  await fixture(async (root, options) => {
    const config = await loadBackupConfig(root, root);
    for (const [index, slot] of slots.entries()) {
      const path = join(root, "protected", String(index));
      const active = { ...options, protectedConfig: slot(path, true) };
      assert(
        !(await buildSourceManifest(config, "id", active)).coverage.complete,
        "missing protected config accepted",
      );
      assert(
        !(await buildSourceManifest(config, "id", {
          ...options,
          protectedConfig: slot(undefined, true),
        })).coverage.complete,
        "omitted active config accepted",
      );
      assert(
        (await buildSourceManifest(config, "id", {
          ...options,
          protectedConfig: slot(path, false),
        })).coverage.complete,
      );
      await write(path);
      assert(
        (await buildSourceManifest(config, "id", active)).files.includes(path),
      );
      await Deno.chmod(path, 0o000);
      assert(
        !(await buildSourceManifest(config, "id", active)).coverage.complete,
      );
      await Deno.chmod(path, 0o600);
    }
    for (
      const protectedConfig of [
        { tls: { active: true, certificate: join(root, ".env") } },
        { rclone: { active: true, config: join(root, ".env") } },
        { pbm: { active: true, env: join(root, ".env") } },
      ]
    ) {
      assert(
        !(await buildSourceManifest(config, "id", {
          ...options,
          protectedConfig,
        })).coverage.complete,
      );
    }
    await Deno.remove(join(root, ".env"));
    assert(
      !(await buildSourceManifest(config, "id", options)).coverage.complete,
    );
  });
});

Deno.test("source safeguards reject escaping symlinks, unreadable and vanished files without losing valid coverage", async () => {
  await fixture(async (root, options) => {
    await write(join(root, "media/good"));
    await write(join(root, "outside/private"));
    await Deno.symlink(
      join(root, "outside/private"),
      join(root, "media/escape"),
    );
    await write(join(root, "media/unreadable"));
    await Deno.chmod(join(root, "media/unreadable"), 0o000);
    const config = await loadBackupConfig(root, root);
    config.mediaSourceHostPath = join(root, "media");
    let manifest = await buildSourceManifest(config, "id", options);
    assert(
      !manifest.coverage.complete && manifest.coverage.outsideRoots === 1 &&
        manifest.coverage.unreadable === 1,
    );
    await Deno.remove(join(root, "media/escape"));
    await Deno.chmod(join(root, "media/unreadable"), 0o600);
    manifest = await buildSourceManifest(config, "id", options);
    await Deno.remove(join(root, "media/unreadable"));
    const result = await reconcileSourcePaths(
      manifest,
      claims(
        "relative",
        join(root, "outside/private"),
        join(root, "media/unreadable"),
        join(root, "media/good"),
      ),
    );
    assert(
      JSON.stringify(result.coverage) ===
        JSON.stringify({
          total: 4,
          covered: 1,
          missing: 1,
          unreadable: 0,
          outsideRoots: 1,
          invalid: 1,
          complete: false,
        }),
    );
  });
});

Deno.test("component-aware containment handles slashes, Unicode, spaces and prefix collisions", async () => {
  await fixture(async (root, options) => {
    for (const name of ["a", "sp ace", "მემო"]) {
      await write(join(root, name, "file"));
      await write(join(root, name + "b", "file"));
      for (const suffix of ["", "/", "//"]) {
        const config = await loadBackupConfig(root, root);
        config.mediaSourceHostPath = join(root, name) + suffix;
        const result = await reconcileSourcePaths(
          await buildSourceManifest(config, "id", options),
          claims(join(root, name, "file"), join(root, name + "b", "file")),
        );
        assert(
          result.coverage.covered === 1 && result.coverage.outsideRoots === 1,
        );
      }
    }
  });
});

Deno.test("Voice Memos replaces staging with archive only after receipt, exact relative path, current size and hash validation", async () => {
  await fixture(async (root, options) => {
    const voice: VoiceMemosMapping = {
      publishedAudioRoot: join(root, "media/staging/audio-original"),
      archiveAudioRoot: join(root, "archive/data/voice-memos/audio-original"),
      receiptPath: join(root, "media/staging/sync-status.json"),
      notBefore: "2026-01-01T00:00:00+00:00",
    };
    const staged = join(voice.publishedAudioRoot, "folder/memo.m4a");
    const archived = join(voice.archiveAudioRoot, "folder/memo.m4a");
    await write(staged);
    await write(archived);
    const payload = {
      schema: 1,
      published_at_utc: new Date(Date.now() + 500).toISOString(),
      published_audio_root: voice.publishedAudioRoot,
      archive_audio_root: voice.archiveAudioRoot,
      not_before: voice.notBefore,
    };
    const receipt = async (changes = {}, mode = 0o600) => {
      await write(
        voice.receiptPath,
        JSON.stringify({ ...payload, ...changes }),
      );
      await Deno.chmod(voice.receiptPath, mode);
    };
    const config = await loadBackupConfig(root, root);
    config.mediaSourceHostPath = join(root, "media");
    const build = () =>
      buildSourceManifest(config, "id", { ...options, voiceMemos: voice });
    const check = async (path = staged) =>
      reconcileSourcePaths(await build(), claims(path), voice);
    await receipt();
    let result = await check();
    assert(result.coverage.complete && result.coverage.covered === 1);
    assert(result.files.includes(archived) && !result.files.includes(staged));
    assert(!result.files.includes(voice.receiptPath));
    for (
      const change of [
        { schema: 0 },
        { published_audio_root: root },
        { archive_audio_root: root },
        { published_at_utc: "bad-date" },
        { published_at_utc: "2000-01-01T00:00:00Z" },
        { not_before: "2025-01-01T00:00:00+00:00" },
      ]
    ) {
      await receipt(change);
      assert(!(await check()).coverage.complete);
    }
    await receipt({}, 0o644);
    assert(!(await check()).coverage.complete);
    await receipt();
    assert(
      !(await check(voice.publishedAudioRoot + "/folder/../folder/memo.m4a"))
        .coverage.complete,
    );
    assert(
      !(await check(
        voice.publishedAudioRoot +
          "/../../../archive/data/voice-memos/audio-original/folder/memo.m4a",
      )).coverage.complete,
      "staging traversal bypassed receipt validation",
    );
    await write(archived, "modified");
    assert(!(await check()).coverage.complete);
    await Deno.remove(archived);
    assert(!(await check()).coverage.complete);
    await write(archived);
    await write(staged, "changed!");
    await receipt();
    assert(!(await check()).coverage.complete);
    result = await reconcileSourcePaths(await build(), {
      filteredCount: 1,
      records: [],
    }, voice);
    assert(!result.coverage.complete, "unconfirmed empty result accepted");
  });
});

Deno.test("manifest never silently accepts a missing archive, empty override or repo-wide media root", async () => {
  await fixture(async (root, options) => {
    const config = await loadBackupConfig(root, root);
    const missing = await buildSourceManifest(config, "id", {
      ...options,
      archiveRoot: join(root, "missing-archive"),
    });
    assert(!missing.coverage.complete && missing.coverage.missing === 1);
    assert(
      !(await buildSourceManifest(config, "id", {
        ...options,
        archiveRoot: "",
      })).coverage.complete,
    );
    config.mediaSourceHostPath = root;
    assert(
      !(await buildSourceManifest(config, "id", options)).coverage.complete,
    );
  });
});

Deno.test("default archive is required and default Pictures import is presence-conditional without touching user data", async () => {
  await fixture(async (root, options) => {
    const config = await loadBackupConfig(root, root);
    const original = Deno.realPath;
    const attempted: string[] = [];
    // Only intercept the two live-user defaults; all temporary filesystem work
    // remains real. Never enumerate the user's actual archive in unit tests.
    Deno.realPath = (path: string | URL) => {
      if (
        path === "/Volumes/TM_data/iCloudArchive" ||
        path === "/Users/pk/Pictures/Mycelia-Import"
      ) {
        attempted.push(String(path));
        return Promise.reject(new Deno.errors.NotFound());
      }
      return original(path);
    };
    try {
      const result = await buildSourceManifest(config, "id", {
        runtimeRoots: options.runtimeRoots,
      });
      assert(attempted.length === 2);
      assert(!result.coverage.complete && result.coverage.missing === 1);
    } finally {
      Deno.realPath = original;
    }
  });
});

Deno.test("protected config symlinks cannot escape their selected parent and active archive roots must match", async () => {
  await fixture(async (root, options) => {
    await write(join(root, "elsewhere/secret"));
    await Deno.mkdir(join(root, "protected"));
    await Deno.symlink(
      join(root, "elsewhere/secret"),
      join(root, "protected/secret"),
    );
    const config = await loadBackupConfig(root, root);
    const result = await buildSourceManifest(config, "id", {
      ...options,
      protectedConfig: {
        provider: { active: true, path: join(root, "protected/secret") },
      },
    });
    assert(!result.coverage.complete && result.coverage.outsideRoots === 1);
    await Deno.mkdir(join(root, "archive/data/voice-memos/audio-original"), {
      recursive: true,
    });
    await Deno.mkdir(join(root, "other-archive"));
    const mismatch = await buildSourceManifest(config, "id", {
      ...options,
      voiceMemos: {
        publishedAudioRoot: join(root, "stage/audio-original"),
        archiveAudioRoot: join(root, "other-archive"),
        receiptPath: join(root, "stage/sync-status.json"),
      },
    });
    assert(!mismatch.coverage.complete && mismatch.coverage.invalid === 1);
  });
});

Deno.test("Voice Memos mapping cannot override the configured published root or exclude the required archive", async () => {
  await fixture(async (root, options) => {
    const config = await loadBackupConfig(root, root);
    const archiveAudioRoot = join(
      root,
      "archive/data/voice-memos/audio-original",
    );
    await Deno.mkdir(archiveAudioRoot, { recursive: true });
    await Deno.mkdir(join(root, "active/audio-original"), { recursive: true });
    await Deno.mkdir(join(root, "other/audio-original"), { recursive: true });
    config.voiceMemosRoot = join(root, "active/audio-original");
    const result = await buildSourceManifest(config, "id", {
      ...options,
      voiceMemos: {
        publishedAudioRoot: join(root, "other/audio-original"),
        archiveAudioRoot,
        receiptPath: join(root, "other/sync-status.json"),
      },
    });
    assert(!result.coverage.complete, "active published root was overridden");
    const excluded = await buildSourceManifest(config, "id", {
      ...options,
      excludedRoots: [join(root, "archive")],
    });
    assert(
      !excluded.coverage.complete,
      "required archive was silently excluded",
    );
  });
});

Deno.test("Voice Memos aliases cannot substitute a different archive relative path", async () => {
  await fixture(async (root, options) => {
    const voice: VoiceMemosMapping = {
      publishedAudioRoot: join(root, "stage/audio"),
      archiveAudioRoot: join(root, "archive/data/voice-memos/audio-original"),
      receiptPath: join(root, "stage/sync-status.json"),
    };
    const staged = join(voice.publishedAudioRoot, "correct.m4a");
    const alias = join(root, "alias/audio/wrong.m4a");
    await write(staged);
    await write(join(voice.archiveAudioRoot, "wrong.m4a"));
    await Deno.mkdir(dirname(alias), { recursive: true });
    await Deno.symlink(staged, alias);
    await Deno.symlink(staged, join(voice.publishedAudioRoot, "wrong.m4a"));
    await write(
      voice.receiptPath,
      JSON.stringify({
        schema: 1,
        published_at_utc: new Date(Date.now() + 500).toISOString(),
        published_audio_root: voice.publishedAudioRoot,
        archive_audio_root: voice.archiveAudioRoot,
      }),
    );
    await Deno.chmod(voice.receiptPath, 0o600);
    const config = await loadBackupConfig(root, root);
    const check = async (path: string) =>
      reconcileSourcePaths(
        await buildSourceManifest(config, "id", {
          ...options,
          voiceMemos: voice,
        }),
        claims(path),
        voice,
      );
    assert(
      !(await check(alias)).coverage.complete,
      "outside lexical alias covered the wrong archived name",
    );
    assert(
      !(await check(join(voice.publishedAudioRoot, "wrong.m4a"))).coverage
        .complete,
      "inside staging symlink covered the wrong archived name",
    );
    await write(join(voice.archiveAudioRoot, "correct.m4a"));
    assert((await check(staged)).coverage.complete);
    assert(
      (await check(join(voice.publishedAudioRoot, "wrong.m4a"))).coverage
        .complete,
    );
    assert(
      !(await check(alias)).coverage.complete,
      "unsupported outside aliases must stay rejected",
    );
  });
});

Deno.test("documented Mongo Redis and RAG runtime directories are excluded without dropping source modules", async () => {
  await fixture(async (root, options) => {
    const media = join(root, "media");
    const runtimeFiles = [
      ".mycelia/data/mongo/WiredTiger",
      ".mycelia/data/redis/dump.rdb",
      "rag_qdrant_data/collection.bin",
      "rag_state/rag-state.sqlite3",
      "rag_model_cache/weights.bin",
    ];
    for (const path of runtimeFiles) await write(join(media, path));
    const sourceFiles = [
      "lib/mongo/source.ts",
      "lib/redis/source.ts",
      "lib/rag_state.ts",
      "lib/rag_model_cache.py",
      "lib/rag_qdrant_data.ts",
    ];
    for (const path of sourceFiles) await write(join(media, path));
    const config = await loadBackupConfig(root, media);
    config.mediaSourceHostPath = media;
    const result = await buildSourceManifest(config, "id", options);
    assert(result.coverage.complete);
    assert(
      runtimeFiles.every((path) => !result.files.includes(join(media, path))),
      "documented live runtime files entered manifest",
    );
    assert(
      sourceFiles.every((path) => result.files.includes(join(media, path))),
      "legitimate source modules were excluded",
    );
  });
});

Deno.test("current backup configuration follows reviewed allowlisting while historical copies stay excluded", async () => {
  await fixture(async (root, options) => {
    await write(
      join(root, ".env.backup"),
      "BACKUP_OPERATIONAL_UNTRACKED_JSON=[]\n",
    );
    await write(join(root, ".env.backup-old"));
    let config = await loadBackupConfig(root, root);
    assert(
      !(await buildSourceManifest(config, "id", options)).files.includes(
        join(root, ".env.backup"),
      ),
    );
    await write(
      join(root, ".env.backup"),
      'BACKUP_OPERATIONAL_UNTRACKED_JSON=[".env.backup",".env.backup-old"]\n',
    );
    config = await loadBackupConfig(root, root);
    const reviewed = await buildSourceManifest(config, "id", options);
    assert(
      reviewed.files.includes(join(root, ".env.backup")),
      "reviewed current backup config was excluded",
    );
    assert(!reviewed.files.includes(join(root, ".env.backup-old")));
    await write(join(root, "media/.env.backup"));
    config.mediaSourceHostPath = join(root, "media");
    assert(
      !(await buildSourceManifest(config, "id", options)).files.includes(
        join(root, "media/.env.backup"),
      ),
      "media traversal implicitly selected backup config",
    );
    config.operationalUntracked.push("media/.env.backup");
    assert(
      (await buildSourceManifest(config, "id", options)).files.includes(
        join(root, "media/.env.backup"),
      ),
    );
  });
});

Deno.test("effective runtime locations are required and deny custom host paths plus canonical aliases", async () => {
  await fixture(async (root, options) => {
    const config = await loadBackupConfig(root, root);
    for (
      const runtimeRoots of [
        undefined,
        {},
        { mongo: { kind: "named-volume" } },
        {
          mongo: { kind: "host-path" },
          redis: { kind: "named-volume" },
          rag: { active: false },
        },
        {
          mongo: { kind: "unknown" },
          redis: { kind: "named-volume" },
          rag: { active: false },
        },
        {
          mongo: { kind: "named-volume" },
          redis: { kind: "named-volume" },
          rag: { active: true },
        },
        {
          mongo: { kind: "named-volume", path: "/hidden-host-path" },
          redis: { kind: "named-volume" },
          rag: { active: false },
        },
      ]
    ) {
      const input = { ...options, runtimeRoots } as ManifestOptions;
      assert(
        !(await buildSourceManifest(config, "id", input)).coverage.complete,
        "omitted or malformed active runtime location accepted",
      );
    }
    const media = join(root, "media");
    config.mediaSourceHostPath = media;
    const locations = [
      "primary-db",
      "queue",
      "vectors",
      "checkpoint",
      "weights",
    ];
    for (const name of locations) await write(join(media, name, "data"));
    await write(join(media, "original.m4a"));
    await Deno.symlink(join(media, "primary-db"), join(media, "alias"));
    const host = (name: string) => ({
      kind: "host-path" as const,
      path: join(media, name),
    });
    const runtimeRoots = {
      mongo: host("alias"),
      redis: host("queue"),
      rag: {
        active: true as const,
        qdrant: host("vectors"),
        state: host("checkpoint"),
        modelCache: host("weights"),
      },
    };
    const result = await buildSourceManifest(
      config,
      "id",
      { ...options, runtimeRoots } as ManifestOptions,
    );
    assert(result.coverage.complete);
    assert(
      locations.every((name) =>
        !result.files.includes(join(media, name, "data"))
      ),
      "custom active runtime root entered manifest",
    );
    assert(result.files.includes(join(media, "original.m4a")));
    const inactive = await buildSourceManifest(
      config,
      "id",
      {
        ...options,
        runtimeRoots: { ...runtimeRoots, rag: { active: false } },
      } as ManifestOptions,
    );
    assert(
      inactive.coverage.complete &&
        inactive.files.includes(join(media, "vectors/data")),
    );
    const namedVolumes = { kind: "named-volume" as const };
    const allNamed = await buildSourceManifest(config, "id", {
      ...options,
      runtimeRoots: {
        mongo: namedVolumes,
        redis: namedVolumes,
        rag: {
          active: true,
          qdrant: namedVolumes,
          state: namedVolumes,
          modelCache: namedVolumes,
        },
      },
    });
    assert(allNamed.coverage.complete);
    const absent = await buildSourceManifest(config, "id", {
      ...options,
      runtimeRoots: {
        mongo: host("absent-mongo"),
        redis: namedVolumes,
        rag: { active: false },
      },
    });
    assert(absent.coverage.complete);
  });
});
