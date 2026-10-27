import { createHash } from "node:crypto";
import { EJSON, ObjectId } from "bson";
import type { Policy } from "./resources.ts";

export interface CredentialBinding {
  id: string;
  fingerprint: string;
}

export interface BoundCredential {
  owner: string;
  policies: Policy[];
  isActive: boolean;
}

/** Changing permissions invalidates previously delegated authority as well. */
export function credentialFingerprint(credential: BoundCredential): string {
  return createHash("sha256").update(EJSON.stringify({
    owner: credential.owner,
    policies: credential.policies,
    isActive: credential.isActive,
  })).digest("hex");
}

export async function readCredential(
  id: string,
): Promise<BoundCredential | null> {
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  // Token validation must not call getServerAuth: workers validate their own JWT.
  const { getRootDB } = await import("../mongo/core.server.ts");
  return await (await getRootDB()).collection("api_keys").findOne(
    { _id: new ObjectId(id), isActive: true },
    { projection: { owner: 1, policies: 1, isActive: 1 }, maxTimeMS: 5_000 },
  ) as BoundCredential | null;
}

export async function isActiveBrowserSession(id: string): Promise<boolean> {
  if (!/^[a-f\d]{64}$/i.test(id)) return false;
  const { getRootDB } = await import("../mongo/core.server.ts");
  return !!await (await getRootDB()).collection<
    { _id: string; expiresAt: Date }
  >("browser_sessions")
    .findOne({ _id: id, expiresAt: { $gt: new Date() } }, {
      projection: { _id: 1 },
      maxTimeMS: 5_000,
    });
}

export async function validateCredentialBindings(
  bindings: unknown,
  read: (id: string) => Promise<BoundCredential | null> = readCredential,
): Promise<boolean> {
  if (
    !Array.isArray(bindings) || bindings.length === 0 || bindings.length > 8
  ) {
    return false;
  }
  for (const binding of bindings) {
    if (
      typeof binding?.id !== "string" || !/^[a-f\d]{24}$/i.test(binding.id) ||
      typeof binding.fingerprint !== "string"
    ) return false;
    const credential = await read(binding.id);
    if (
      !credential?.isActive ||
      credentialFingerprint(credential) !== binding.fingerprint
    ) return false;
  }
  return true;
}
