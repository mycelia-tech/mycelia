import { Buffer } from "node:buffer";
import { createHash, createSecretKey, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";
import { APIKey, Auth, getServerAuth } from "./core.server.ts";
import { Policy } from "./resources.ts";
import { z } from "zod";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { ObjectId } from "bson";
import { env } from "#/env.ts";
import { type CredentialBinding, credentialFingerprint } from "./credentials.ts";

const OPEN_PREFIX_LENGTH = 16;

const apiKeySchema = z.object({
  _id: z.instanceof(ObjectId).optional(),
  hashedKey: z.string(),
  salt: z.string(),
  owner: z.string(),
  name: z.string(),
  policies: z.array(z.any()),
  openPrefix: z.string(),
  createdAt: z.date(),
  isActive: z.boolean(),
  redirectUris: z.array(z.string()).optional(),
});

export type APIKeyDocument = z.infer<typeof apiKeySchema>;

function hashApiKey(apiKey: string, salt: Buffer): string {
  return createHash("sha256").update(salt).update(apiKey).digest("base64");
}

export async function generateApiKey(
  owner: string,
  name: string,
  policies: Policy[],
): Promise<string> {
  const result = await generateApiKeyWithId(owner, name, policies);
  return result.apiKey;
}

export async function generateApiKeyWithId(
  owner: string,
  name: string,
  policies: Policy[],
  redirectUris?: string[],
): Promise<{ apiKey: string; clientId: string }> {
  const apiKey = `mycelia_${randomBytes(32).toString("base64url")}`;
  const salt = randomBytes(32);
  const hashedKey = hashApiKey(apiKey, salt);

  const auth = await getServerAuth();
  const mongo = await getMongoResource(auth);

  const newApiKey: Omit<APIKeyDocument, "_id"> = {
    hashedKey,
    salt: salt.toString("base64"),
    owner,
    name,
    policies,
    openPrefix: apiKey.slice(0, OPEN_PREFIX_LENGTH),
    createdAt: new Date(),
    isActive: true,
    ...(redirectUris && { redirectUris }),
  };

  const result = await mongo({
    action: "insertOne",
    collection: "api_keys",
    doc: newApiKey,
  });
  const clientId = result.insertedId.toString();

  return { apiKey, clientId };
}

export async function verifyApiKey(apiKey: string): Promise<APIKey | null> {
  const auth = await getServerAuth();
  const mongo = await getMongoResource(auth);

  const keyDoc = await mongo({
    action: "findOne",
    collection: "api_keys",
    query: {
      openPrefix: apiKey.slice(0, OPEN_PREFIX_LENGTH),
      isActive: true,
    },
  });

  if (!keyDoc) {
    return null;
  }

  if (typeof keyDoc.salt !== "string" || typeof keyDoc.hashedKey !== "string") return null;

  const salt = Buffer.from(keyDoc.salt, "base64");
  const hashedInput = hashApiKey(apiKey, salt);

  const expected = Buffer.from(keyDoc.hashedKey, "base64");
  const actual = Buffer.from(hashedInput, "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  return keyDoc as APIKey;
}

export async function signJWT(
  owner: string,
  principal: string,
  policies: Policy[],
  duration: string,
  credentialBindings?: CredentialBinding[],
  browserSessionId?: string,
) {
  return new SignJWT({
    owner,
    principal,
    policies: JSON.parse(JSON.stringify(policies)),
    tokenKind: credentialBindings ? "credential" : "internal",
    ...(credentialBindings && { credentialBindings }),
    ...(browserSessionId && { browserSessionId }),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(duration)
    .sign(createSecretKey(
      Buffer.from(env.SECRET_KEY, "utf-8"),
    ));
}

export async function decodeAccessToken(
  apiKey: string,
  duration: string = "1 day",
): Promise<string | null> {
  const keyDoc = await verifyApiKey(apiKey);

  if (!keyDoc) {
    return null;
  }

  return signJWT(
    keyDoc._id!.toString(),
    keyDoc.owner,
    keyDoc.policies,
    duration,
    [{ id: keyDoc._id!.toString(), fingerprint: credentialFingerprint(keyDoc) }],
  );
}

export async function exchangeApiKeyForAccessToken(
  token: string,
  duration: string = "1 day",
): Promise<{ jwt: string | null; error: string | null }> {
  if (typeof token !== "string" || token.length === 0) {
    return { jwt: null, error: "Token is required" };
  }

  const jwt = await decodeAccessToken(token, duration);
  if (!jwt) {
    return { jwt: null, error: "Invalid token" };
  }

  return { jwt, error: null };
}

export async function listApiKeys(auth: Auth): Promise<APIKeyDocument[]> {
  const mongo = await getMongoResource(auth);

  const docs = await mongo({
    action: "find",
    collection: "api_keys",
    query: {},
    options: { sort: { createdAt: -1 } },
  });
  return docs as APIKeyDocument[];
}

export async function revokeApiKey(
  owner: string,
  id: string,
): Promise<boolean> {
  const auth = await getServerAuth();
  const mongo = await getMongoResource(auth);

  const result = await mongo({
    action: "updateOne",
    collection: "api_keys",
    query: { _id: new ObjectId(id), owner },
    update: { $set: { isActive: false } },
  });

  return Boolean(result && (result.modifiedCount || result.matchedCount));
}

export async function updateApiKeyPolicies(
  owner: string,
  id: string,
  policies: Policy[],
): Promise<boolean> {
  const auth = await getServerAuth();
  const mongo = await getMongoResource(auth);

  const result = await mongo({
    action: "updateOne",
    collection: "api_keys",
    query: { _id: new ObjectId(id), owner },
    update: { $set: { policies } },
  });

  return Boolean(result && (result.modifiedCount || result.matchedCount));
}
