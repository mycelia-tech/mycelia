import { statfs } from "node:fs/promises";
import { join } from "node:path";

const GiB = 1024 ** 3;
export const MINIMUM_TEST_FREE_BYTES = 5 * GiB;
export type TestContainerRole = "mongo" | "redis";

type ContainerInventoryEntry = {
  Id?: string;
  Names?: string[];
  Image: string;
  State: string;
  Labels?: Record<string, string | undefined>;
};

export function runningTestDatabases(inventory: ContainerInventoryEntry[]) {
  const databaseImages = new Set([
    "mongo",
    "mongodb",
    "mongodb-community-server",
    "redis",
    "redis-stack",
    "redis-stack-server",
  ]);
  return inventory.filter((container) => {
    if (!["running", "paused", "restarting"].includes(container.State)) {
      return false;
    }
    const labels = container.Labels ?? {};
    // This marker is exclusive to the runner's Mongo/Redis pair. An untagged
    // image may be listed by ID; that must not hide an owned orphan.
    if (labels["mycelia.test-run"]) return true;
    const image = container.Image.split("@", 1)[0].split("/").at(-1)?.split(
      ":",
      1,
    )[0].toLowerCase();
    if (!image || !databaseImages.has(image)) return false;
    return Boolean(
      labels["org.testcontainers"] === "true" ||
        labels["org.testcontainers.session-id"] ||
        labels["org.testcontainers.container-hash"],
    );
  }).map((container) => ({
    id: container.Id?.replace(/[^a-f0-9]/gi, "").slice(0, 64) || "unknown",
    name: (container.Names?.[0] ?? "unknown").replace(/[^a-zA-Z0-9_./-]/g, "?")
      .slice(0, 80),
  }));
}

export function requireNoRunningTestDatabases(
  inventory: ContainerInventoryEntry[],
): void {
  const existing = runningTestDatabases(inventory);
  if (!existing.length) return;
  const remainder = existing.length > 5
    ? ` (+${existing.length - 5} more)`
    : "";
  throw new Error(
    `Backend test admission refused: ${existing.length} active test Mongo/Redis container(s) already exist: ${
      JSON.stringify(existing.slice(0, 5))
    }${remainder}. Wait for the other suite or inspect its owned cleanup before retrying. No containers were started, stopped, or removed.`,
  );
}

export function requireTestRunnerVersion(version: string): void {
  if (version !== "2.9.5") {
    throw new Error(
      `Backend test runner requires Deno 2.9.5, matching CI; selected ${version}. Use the Deno 2.9.5 executable before retrying.`,
    );
  }
}

export function testContainerLimits(role: TestContainerRole) {
  const memory = role === "mongo" ? GiB : GiB / 4;
  return {
    Memory: memory,
    MemorySwap: memory,
    NanoCpus: role === "mongo" ? 1_000_000_000 : 500_000_000,
  };
}

export function boundedMongoCommand(command: string[] | undefined): string[] {
  if (
    !command?.includes("--replSet") ||
    command.includes("--wiredTigerCacheSizeGB")
  ) {
    throw new Error(
      "Unexpected Mongo test startup command; cannot safely apply cache limit",
    );
  }
  return [...command, "--wiredTigerCacheSizeGB", "0.25"];
}

export const REDIS_TEST_COMMAND = [
  "redis-server",
  "--maxmemory",
  "128mb",
  "--maxmemory-policy",
  "noeviction",
];

export function assertTestContainerLimits(
  role: TestContainerRole,
  inspect: {
    HostConfig?: { Memory?: number; MemorySwap?: number; NanoCpus?: number };
    Config?: { Cmd?: string[] | null };
  },
): void {
  const expected = testContainerLimits(role);
  for (const name of ["Memory", "MemorySwap", "NanoCpus"] as const) {
    if (inspect.HostConfig?.[name] !== expected[name]) {
      throw new Error(
        `${role} test container is missing its required ${name} limit`,
      );
    }
  }
  const command = inspect.Config?.Cmd ?? [];
  const option = role === "mongo" ? "--wiredTigerCacheSizeGB" : "--maxmemory";
  const expectedValue = role === "mongo" ? "0.25" : "128mb";
  if (
    command[command.indexOf(option) + 1] !== expectedValue ||
    !command.includes(option)
  ) {
    throw new Error(
      `${role} test container is missing its application memory limit`,
    );
  }
  if (
    role === "redis" &&
    command[command.indexOf("--maxmemory-policy") + 1] !== "noeviction"
  ) {
    throw new Error(
      "Redis test container must report exhaustion instead of evicting test data",
    );
  }
}

export async function requireTestDiskCapacity(
  paths: string[],
  read: (path: string) => Promise<{ bavail: number; bsize: number }> = statfs,
): Promise<void> {
  for (const path of [...new Set(paths)]) {
    const stats = await read(path);
    const free = stats.bavail * stats.bsize;
    if (!Number.isFinite(free) || free < MINIMUM_TEST_FREE_BYTES) {
      const available = Number.isFinite(free)
        ? `${(free / GiB).toFixed(2)} GiB`
        : "unknown";
      throw new Error(
        `Backend tests require at least 5 GiB free at ${path}; available: ${available}. Free disk space before retrying. No test containers were started.`,
      );
    }
  }
}

type LeaseOwner = {
  owner: string;
  checkout: string;
  pid: number;
  startedAt: string;
};

function privateEntry(info: Deno.FileInfo, uid: number, directory: boolean) {
  return !info.isSymlink && (directory ? info.isDirectory : info.isFile) &&
    info.uid === uid && ((info.mode ?? 0) & 0o077) === 0 &&
    (directory || info.nlink === 1);
}

function describeOwner(data: Uint8Array): string {
  try {
    const value = JSON.parse(new TextDecoder().decode(data)) as Partial<
      LeaseOwner
    >;
    if (
      !Number.isInteger(value.pid) || typeof value.checkout !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      return "Owner metadata is unavailable.";
    }
    return `Last recorded owner: ${
      JSON.stringify({
        pid: value.pid,
        checkout: value.checkout.slice(0, 400),
        startedAt: value.startedAt.slice(0, 40),
      })
    }.`;
  } catch {
    return "Owner metadata is unavailable.";
  }
}

/**
 * A persistent inode with a kernel lock, shared by this user's worktrees and
 * Docker contexts. Never unlink it: deletion could permit a second active lock.
 * Kernel ownership ends when the file/process closes, including SIGKILL.
 */
export async function acquireTestRunLease(
  owner: Pick<LeaseOwner, "owner" | "checkout">,
  directory?: string,
): Promise<{ path: string; release(): void }> {
  const uid = Deno.uid();
  if (uid === null) {
    throw new Error("Backend test leases require a local POSIX host");
  }
  const base = directory ?? `/tmp/mycelia-backend-tests-${uid}`;
  try {
    await Deno.mkdir(base, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  if (!privateEntry(await Deno.lstat(base), uid, true)) {
    throw new Error(
      "Backend test lease directory must be private, owned by this user, and not a symlink",
    );
  }
  const path = join(base, "runner.lock");
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, {
      read: true,
      write: true,
      createNew: true,
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    const previous = await Deno.lstat(path);
    if (!privateEntry(previous, uid, false)) {
      throw new Error(
        "Backend test lease must be a private, owned regular file without links",
      );
    }
    file = await Deno.open(path, { read: true, write: true });
    try {
      const opened = await file.stat();
      if (
        !privateEntry(opened, uid, false) || opened.ino !== previous.ino ||
        opened.dev !== previous.dev
      ) {
        throw new Error(
          "Backend test lease changed while opening; refusing to use it",
        );
      }
    } catch (error) {
      file.close();
      throw error;
    }
  }
  try {
    const lockable = file as Deno.FsFile & {
      tryLock?: (exclusive: boolean) => Promise<boolean>;
    };
    if (typeof lockable.tryLock !== "function") {
      throw new Error(
        "Nonblocking backend test locking is unavailable. Use the Deno 2.9.5 executable, matching CI.",
      );
    }
    if (!await lockable.tryLock(true)) {
      const data = new Uint8Array(2048);
      const count = await file.read(data) ?? 0;
      throw new Error(
        `Another backend test suite is active for this user. ${
          describeOwner(data.subarray(0, count))
        } Wait for it to finish; inspect that process if it appears stuck. Do not remove ${path}.`,
      );
    }
    const record: LeaseOwner = {
      ...owner,
      pid: Deno.pid,
      startedAt: new Date().toISOString(),
    };
    await file.truncate(0);
    const data = new TextEncoder().encode(JSON.stringify(record));
    let written = 0;
    while (written < data.length) {
      const count = await file.write(data.subarray(written));
      if (count === 0) {
        throw new Error("Could not write backend test lease metadata");
      }
      written += count;
    }
    let released = false;
    return {
      path,
      release() {
        if (released) return;
        released = true;
        file.close();
      },
    };
  } catch (error) {
    file.close();
    throw error;
  }
}
