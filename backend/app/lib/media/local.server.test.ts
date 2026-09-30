import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.15";
import { PDFDocument } from "pdf-lib";
import { stub } from "@std/testing/mock";
import { env } from "#/env.ts";
import {
  assertSafeMediaRelativePath,
  detectMediaMime,
  inspectCapturedAt,
  listMediaSourceFolders,
  mediaLocationFromMetadata,
  prepareUploadedMedia,
  readExifMetadata,
  readMediaSourceDirectoryPage,
  resolveMediaSourcePath,
  scanMediaSourceInventory,
} from "./local.server.ts";

// Folder fixtures must not inherit the developer's configured physical disks.
env.MEDIA_SOURCE_ALIASES = "{}";
env.MEDIA_SOURCE_DISKS_DIR = "";

Deno.test("optional disks reconnect without changing stored alias paths or scanning other sources", async () => {
  const root = await Deno.realPath(await Deno.makeTempDir());
  const previous = {
    root: env.MEDIA_SOURCE_ROOT,
    disks: env.MEDIA_SOURCE_DISKS_DIR,
    aliases: env.MEDIA_SOURCE_ALIASES,
  };
  env.MEDIA_SOURCE_ROOT = root;
  env.MEDIA_SOURCE_DISKS_DIR = "disks";
  env.MEDIA_SOURCE_ALIASES = JSON.stringify({
    "icloud-backup": "disks/TestDisk/photos",
  });
  try {
    await Deno.mkdir(`${root}/disks`);
    await Deno.writeTextFile(`${root}/local.jpg`, "local");
    const offline = await listMediaSourceFolders(".");
    assertEquals(
      Boolean(
        offline.folders.find((f) => f.relativePath === "icloud-backup")
          ?.unavailableReason,
      ),
      true,
    );
    assertEquals(
      (await listMediaSourceFolders("disks")).scanUnavailableReason,
      "Choose a disk or a folder before scanning",
    );
    await assertRejects(
      () => readMediaSourceDirectoryPage("./disks/"),
      Error,
      "Choose a disk",
    );

    await Deno.mkdir(`${root}/disks/TestDisk/photos/nested`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/disks/TestDisk/photos/nested/photo.jpg`,
      "external",
    );
    const online = await listMediaSourceFolders(".");
    assertEquals(
      online.folders.find((f) => f.relativePath === "icloud-backup")
        ?.unavailableReason,
      undefined,
    );
    assertEquals(
      (await listMediaSourceFolders("icloud-backup")).folders[0].relativePath,
      "icloud-backup/nested",
    );
    assertEquals(
      (await listMediaSourceFolders("icloud-backup")).parentPath,
      ".",
    );
    assertEquals(
      (await readMediaSourceDirectoryPage("icloud-backup/nested")).entries[0]
        .relativePath,
      "icloud-backup/nested/photo.jpg",
    );
    assertEquals((await scanMediaSourceInventory("icloud-backup", 10)).paths, [
      "icloud-backup/nested/photo.jpg",
    ]);
    assertEquals(
      (await resolveMediaSourcePath("icloud-backup/nested/photo.jpg")).realPath,
      `${root}/disks/TestDisk/photos/nested/photo.jpg`,
    );
    assertEquals((await scanMediaSourceInventory(".", 10)).paths, [
      "local.jpg",
    ]);
    assertEquals(
      (await readMediaSourceDirectoryPage(".")).entries.map((e) =>
        e.relativePath
      ),
      ["local.jpg"],
    );

    await Deno.rename(`${root}/disks/TestDisk`, `${root}/disconnected`);
    await assertRejects(
      () => resolveMediaSourcePath("icloud-backup/nested/photo.jpg"),
      Error,
      "Connect the external disk",
    );
    await Deno.rename(`${root}/disconnected`, `${root}/disks/TestDisk`);
    assertEquals(
      (await resolveMediaSourcePath("icloud-backup/nested/photo.jpg"))
        .relativePath,
      "icloud-backup/nested/photo.jpg",
    );
  } finally {
    env.MEDIA_SOURCE_ROOT = previous.root;
    env.MEDIA_SOURCE_DISKS_DIR = previous.disks;
    env.MEDIA_SOURCE_ALIASES = previous.aliases;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("media aliases preserve traversal and symlink protection", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  const previous = env.MEDIA_SOURCE_ALIASES;
  try {
    await Deno.symlink(outside, `${root}/linked`);
    env.MEDIA_SOURCE_ALIASES = JSON.stringify({ archive: "linked" });
    await assertRejects(
      () => resolveMediaSourcePath("archive", root),
      Error,
      "symlinks are not allowed",
    );
    env.MEDIA_SOURCE_ALIASES = JSON.stringify({ archive: "../outside" });
    await assertRejects(
      () => resolveMediaSourcePath("archive", root),
      Error,
      '".." are not allowed',
    );
    env.MEDIA_SOURCE_ALIASES = JSON.stringify({ archive: outside });
    await assertRejects(
      () => resolveMediaSourcePath("archive", root),
      Error,
      "absolute paths",
    );
  } finally {
    env.MEDIA_SOURCE_ALIASES = previous;
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("mounted media paths must stay relative to the configured root", () => {
  assertSafeMediaRelativePath(".");
  assertSafeMediaRelativePath("2026/photos");
  assertThrows(
    () => assertSafeMediaRelativePath("/Users/example/Pictures"),
    Error,
    "relative to the configured media source",
  );
  assertThrows(
    () => assertSafeMediaRelativePath("../private"),
    Error,
    '".." are not allowed',
  );
});

Deno.test("missing exiftool fails visibly instead of importing silently without GPS or time", async () => {
  const command = stub(
    Deno,
    "Command",
    function () {
      throw new Deno.errors.NotFound("exiftool is not installed");
    },
  );
  try {
    await assertRejects(
      () => readExifMetadata("photo.jpg"),
      Error,
      "EXIF_METADATA_TOOL_UNAVAILABLE",
    );
  } finally {
    command.restore();
  }
});

Deno.test("directory inventory pages over 20000 files without following symlinks or losing names", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (let index = 0; index < 20_025; index++) {
      await Deno.writeTextFile(
        `${root}/${String(index).padStart(6, "0")}.jpg`,
        "",
      );
    }
    await Deno.mkdir(`${root}/nested`);
    await Deno.writeTextFile(`${root}/sidecar.xmp`, "");
    await Deno.symlink(`${root}/nested`, `${root}/linked-folder`);
    await Deno.symlink(`${root}/000000.jpg`, `${root}/linked-photo.jpg`);
    const seen = new Set<string>();
    let afterName: string | undefined;
    do {
      const page = await readMediaSourceDirectoryPage(
        ".",
        afterName,
        1_000,
        root,
      );
      assertEquals(page.entries.length <= 1_000, true);
      for (const entry of page.entries) {
        assertEquals(seen.has(entry.relativePath), false);
        seen.add(entry.relativePath);
      }
      afterName = page.nextAfterName;
    } while (afterName);
    assertEquals(seen.size, 20_027);
    assertEquals(seen.has("linked-photo.jpg"), false);
    assertEquals(seen.has("linked-folder"), false);
    await assertRejects(
      () => resolveMediaSourcePath("linked-folder", root),
      Error,
      "symlinks are not allowed",
    );
    await assertRejects(
      () => readMediaSourceDirectoryPage("missing-disk", "", 1_000, root),
      Error,
      "Connect the external disk",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("mounted media folder browser lists directories without following symlinks", async () => {
  const root = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/Trips/Day 2`, { recursive: true });
    await Deno.mkdir(`${root}/archive-10`);
    await Deno.mkdir(`${root}/archive-2`);
    await Deno.writeTextFile(`${root}/photo.jpg`, "not inspected here");
    await Deno.symlink(outside, `${root}/outside-link`);

    const rootListing = await listMediaSourceFolders(".", root);
    assertEquals(rootListing, {
      currentPath: ".",
      folders: [
        { name: "archive-2", relativePath: "archive-2" },
        { name: "archive-10", relativePath: "archive-10" },
        { name: "Trips", relativePath: "Trips" },
      ],
    });
    assertEquals(await listMediaSourceFolders("Trips", root), {
      currentPath: "Trips",
      parentPath: ".",
      folders: [{ name: "Day 2", relativePath: "Trips/Day 2" }],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("detectMediaMime trusts magic bytes rather than the filename", () => {
  assertEquals(
    detectMediaMime(
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]),
    ),
    { kind: "image", mimeType: "image/png" },
  );
  assertThrows(
    () => detectMediaMime(new TextEncoder().encode("photo")),
    Error,
    "Unsupported or invalid media file",
  );
});

Deno.test("prepareUploadedMedia inspects an uploaded PDF without retaining its path", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  const prepared = await prepareUploadedMedia(
    await pdf.save(),
    "../unsafe/name.pdf",
    { maxImageBytes: 1_000_000, maxPdfBytes: 1_000_000, maxPdfPages: 15 },
  );
  assertEquals(prepared.inspection.fileName, "name.pdf");
  assertEquals(prepared.inspection.kind, "pdf");
  assertEquals(prepared.inspection.pageCount, 1);
  assertEquals(prepared.thumbnail, undefined);
});

Deno.test("naive EXIF capture time is deterministic and marked timezone unknown", () => {
  const inspected = inspectCapturedAt({
    exif: { DateTimeOriginal: "2026:08:21 12:34:56.125" },
  });
  assertEquals(
    inspected.capturedAt?.toISOString(),
    "2026-08-21T12:34:56.125Z",
  );
  assertEquals(inspected.capturedAtTimeZone, undefined);
  assertEquals(inspected.capturedAtTimeZoneSource, "unknown");
});

Deno.test("EXIF offset fields turn wall-clock capture time into an instant", () => {
  const originalOffset = inspectCapturedAt({
    exif: {
      DateTimeOriginal: "2026:08:21 12:34:56",
      OffsetTimeOriginal: "+04:00",
    },
  });
  assertEquals(
    originalOffset.capturedAt?.toISOString(),
    "2026-08-21T08:34:56.000Z",
  );
  assertEquals(originalOffset.capturedAtTimeZone, "+04:00");
  assertEquals(originalOffset.capturedAtTimeZoneSource, "exif_offset");

  const digitizedFallback = inspectCapturedAt({
    exif: {
      DateTimeOriginal: "2026:08:21 12:34:56",
      OffsetTimeDigitized: "-0230",
    },
  });
  assertEquals(
    digitizedFallback.capturedAt?.toISOString(),
    "2026-08-21T15:04:56.000Z",
  );
  assertEquals(digitizedFallback.capturedAtTimeZone, "-02:30");
  assertEquals(digitizedFallback.capturedAtTimeZoneSource, "exif_offset");
});

Deno.test("an embedded capture offset takes precedence over EXIF offset tags", () => {
  const inspected = inspectCapturedAt({
    exif: {
      DateTimeOriginal: "2026:08:21 12:34:56Z",
      OffsetTimeOriginal: "+04:00",
    },
  });
  assertEquals(
    inspected.capturedAt?.toISOString(),
    "2026-08-21T12:34:56.000Z",
  );
  assertEquals(inspected.capturedAtTimeZone, "Z");
  assertEquals(inspected.capturedAtTimeZoneSource, "embedded");
});

Deno.test("prepareUploadedMedia preserves local EXIF date and GPS metadata", async () => {
  const source = await Deno.makeTempFile({ suffix: ".jpg" });
  try {
    const generated = await new Deno.Command("ffmpeg", {
      args: [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=green:s=32x24",
        "-frames:v",
        "1",
        "-y",
        source,
      ],
    }).output();
    assertEquals(generated.success, true);
    const tagged = await new Deno.Command("exiftool", {
      args: [
        "-overwrite_original",
        "-GPSLatitude=40.18",
        "-GPSLongitude=44.51",
        "-DateTimeOriginal=2026:08:21 12:34:56",
        source,
      ],
    }).output();
    assertEquals(tagged.success, true);

    const prepared = await prepareUploadedMedia(
      await Deno.readFile(source),
      "tagged.jpg",
      { maxImageBytes: 1_000_000, maxPdfBytes: 1_000_000, maxPdfPages: 15 },
      { createPreviews: false },
    );
    assertEquals(
      prepared.inspection.capturedAt?.toISOString(),
      "2026-08-21T12:34:56.000Z",
    );
    assertEquals(
      prepared.inspection.capturedAtTimeZoneSource,
      "unknown",
    );
    assertEquals(prepared.inspection.location, {
      latitude: 40.18,
      longitude: 44.51,
    });
    assertEquals(
      (prepared.inspection.metadata.location as any)?.latitude,
      40.18,
    );
    assertEquals(
      (prepared.inspection.metadata.location as any)?.longitude,
      44.51,
    );
    assertEquals(mediaLocationFromMetadata(prepared.inspection.metadata), {
      latitude: 40.18,
      longitude: 44.51,
    });
  } finally {
    await Deno.remove(source).catch(() => undefined);
  }
});
