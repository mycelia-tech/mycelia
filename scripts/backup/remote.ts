import type { FailureCode, Runner } from "./types.ts";
import { failureError, isUtc } from "./redact.ts";
// Fixed argv is insufficient: inherited rclone options can hide namespace
// entries or select a different remote/config. Reject every override, including
// unknown future options. Only names are examined; values are never retained.
export function assertRcloneEnvironment(): void {
  if (
    Object.keys(Deno.env.toObject()).some((name) => name.startsWith("RCLONE_"))
  ) {
    throw failureError("CONFIG_INVALID");
  }
}
export const OWNER_MARKER = "owner-v1.json";
export type RemoteOptions = {
  rcloneRemote: string;
  remoteRoot: string;
  remoteMinFreeBytes: number;
  fileBytes: number;
  databaseBytes: number;
  expectedInstallationId?: string;
};
export type RemoteResult = {
  namespace: "reservable" | "owned";
  requiredBytes: number;
  freeBytes: number;
};
export const OWNER_CHILDREN = [
  "restic-v1/",
  "bootstrap-manifests/",
  "logs/",
] as const;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export type OwnerMarker = {
  schema: 1;
  installationId: string;
  createdAtUtc: string;
  children: string[];
};
export function parseOwnerMarker(
  text: string,
  expectedInstallationId?: string,
): OwnerMarker {
  try {
    const value = JSON.parse(text);
    if (
      !value ||
      Object.keys(value).sort().join(",") !==
        "children,createdAtUtc,installationId,schema" ||
      value.schema !== 1 || !uuid.test(value.installationId) ||
      !isUtc(value.createdAtUtc) ||
      Date.parse(value.createdAtUtc) > Date.now() + 1000 ||
      JSON.stringify(value.children) !== JSON.stringify(OWNER_CHILDREN) ||
      (expectedInstallationId !== undefined &&
        value.installationId !== expectedInstallationId)
    ) throw 0;
    return value;
  } catch {
    throw failureError("REMOTE_NAMESPACE_UNKNOWN");
  }
}
export async function checkRemote(
  options: RemoteOptions,
  runner: Runner,
): Promise<RemoteResult> {
  assertRcloneEnvironment();
  const fail = (code: FailureCode): never => {
    throw failureError(code);
  };
  const { rcloneRemote, remoteRoot } = options;
  if (
    !/^[a-zA-Z0-9_-]+:$/.test(rcloneRemote) ||
    remoteRoot !== `${rcloneRemote}mycelia`
  ) fail("REMOTE_NAMESPACE_UNKNOWN");
  const sizes = [
    options.remoteMinFreeBytes,
    options.fileBytes,
    options.databaseBytes,
  ];
  if (sizes.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    fail("REMOTE_CAPACITY_UNKNOWN");
  }
  const required = BigInt(options.remoteMinFreeBytes) +
    ((BigInt(options.fileBytes) + BigInt(options.databaseBytes)) * 5n + 3n) /
      4n;
  if (required > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("REMOTE_CAPACITY_UNKNOWN");
  }
  const run = async (args: string[], code: FailureCode): Promise<string> => {
    assertRcloneEnvironment();
    try {
      const result = await runner.run(["rclone", ...args], {
        timeoutMs: 30_000,
        maxOutputBytes: 1024 * 1024,
      });
      try {
        if (result.code !== 0 || result.timedOut) {
          if (
            /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key (?:mismatch|has changed)/i
              .test(new TextDecoder().decode(result.stderr))
          ) fail("HOST_KEY_MISMATCH");
          fail(code);
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
      } finally {
        result.stdout.fill(0);
        result.stderr.fill(0);
      }
    } catch (error) {
      if ((error as { code?: string })?.code === "HOST_KEY_MISMATCH") {
        throw error;
      }
      return fail(code);
    }
  };
  const listing = (text: string) =>
    text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const root = listing(
    await run(["lsf", rcloneRemote], "SSH_NONINTERACTIVE_REQUIRED"),
  );
  let freeBytes: number;
  try {
    freeBytes = JSON.parse(
      await run(["about", rcloneRemote, "--json"], "REMOTE_CAPACITY_UNKNOWN"),
    ).free;
  } catch (error) {
    if ((error as { code?: string })?.code === "HOST_KEY_MISMATCH") throw error;
    fail("REMOTE_CAPACITY_UNKNOWN");
  }
  if (!Number.isSafeInteger(freeBytes!) || freeBytes! < 0) {
    fail("REMOTE_CAPACITY_UNKNOWN");
  }
  if (BigInt(freeBytes!) < required) fail("REMOTE_CAPACITY_LOW");
  const response = { requiredBytes: Number(required), freeBytes: freeBytes! };
  if (
    root.includes("mycelia") || root.filter((x) => x === "mycelia/").length > 1
  ) fail("REMOTE_NAMESPACE_UNKNOWN");
  if (!root.includes("mycelia/")) {
    return { ...response, namespace: "reservable" };
  }
  const entries = listing(
    await run(["lsf", remoteRoot], "REMOTE_NAMESPACE_UNKNOWN"),
  );
  if (!entries.length) return { ...response, namespace: "reservable" };
  if (
    new Set(entries).size !== entries.length ||
    !entries.includes(OWNER_MARKER) ||
    entries.some((x) =>
      x !== OWNER_MARKER && !(OWNER_CHILDREN as readonly string[]).includes(x)
    )
  ) fail("REMOTE_NAMESPACE_UNKNOWN");
  if (options.expectedInstallationId === undefined) {
    fail("REMOTE_NAMESPACE_UNKNOWN");
  }
  parseOwnerMarker(
    await run(
      ["cat", `${remoteRoot}/${OWNER_MARKER}`],
      "REMOTE_NAMESPACE_UNKNOWN",
    ),
    options.expectedInstallationId,
  );
  return { ...response, namespace: "owned" };
}
