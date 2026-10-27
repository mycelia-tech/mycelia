import { jwtVerify } from "jose";
import { permissionDenied } from "./utils.ts";
import { ObjectId } from "bson";
import type { Request, Response } from "express";

import {
  defaultResourceManager,
  Policy,
  Resource,
  ResourcePath,
} from "./resources.ts";
import { EJSON } from "bson";
import { redis } from "@/lib/redis.ts";
import { env } from "#/env.ts";
import { type CredentialBinding, isActiveBrowserSession, readCredential, validateCredentialBindings } from "./credentials.ts";

export interface APIKey {
  hashedKey: string;
  salt: string;
  owner: string;
  name: string;
  openPrefix: string;
  createdAt: Date;
  isActive: boolean;
  policies: Policy[];
  _id?: ObjectId;
}

class AccessLogger {
  async log(
    auth: Auth,
    resource: Resource<any, any>,
    actions: {
      path: ResourcePath;
      actions: string[];
    }[],
  ) {
    try {
      const timestamp = new Date().toISOString();
      const fields: string[] = [
        "principal",
        auth.principal,
        "resource",
        resource.code,
        "actions",
        JSON.stringify(actions),
        "timestamp",
        timestamp,
      ];

      await redis.xadd("access_logs", "*", ...fields);
    } catch (error) {
      console.error("[AccessLogger] Failed to write access log to Redis stream:", error);
      throw error;
    }
  }
}

export const accessLogger = new AccessLogger();

export class Auth {
  policies: Policy[];
  principal: string;
  credentialBindings?: CredentialBinding[];
  constructor(options: {
    policies?: Policy[];
    principal: string;
    credentialBindings?: CredentialBinding[];
  }) {
    this.policies = options.policies || [];
    this.principal = options.principal;
    this.credentialBindings = options.credentialBindings;
  }

  getResource<Input, Output>(
    code: string,
  ): (input: Input) => Promise<Output | Response> {
    const token = Deno.env.get("MYCELIA_JWT");
    const myceliaUrl = env.MYCELIA_URL;

    // Prefer local resource if it's registered
    if (defaultResourceManager.listResources().some(r => r.code === code)) {
      return defaultResourceManager.getResource(code, this);
    }

    if (token && myceliaUrl) {
      console.log(`[Auth] Using remote resource call for ${code} via ${myceliaUrl}`);
      return async (input: Input): Promise<Output | Response> => {
        const url = `${myceliaUrl.replace(/\/$/, "")}/api/resource/${code}`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
          },
          body: EJSON.stringify(EJSON.serialize(input)),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Resource call failed: ${response.status} ${errorText}`);
        }

        const text = await response.text();
        return EJSON.deserialize(JSON.parse(text)) as Output;
      };
    }

    return defaultResourceManager.getResource(code, this);
  }
}

export const verifyToken = async (token: string, dependencies: {
  readCredential?: typeof readCredential;
  activeSession?: typeof isActiveBrowserSession;
} = {}): Promise<null | Auth> => {
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.SECRET_KEY),
      { algorithms: ["HS256"] },
    );
    if (typeof payload === "string") {
      permissionDenied();
    }
    if (typeof payload.principal !== "string" || !Array.isArray(payload.policies)) {
      return null;
    }
    // Legacy unbound user JWTs must be exchanged again; accepting them would
    // retain their old privileges after a key was revoked or downgraded.
    if (payload.tokenKind === "credential") {
      if (!await validateCredentialBindings(payload.credentialBindings, dependencies.readCredential)) return null;
      if (payload.browserSessionId !== undefined &&
        (typeof payload.browserSessionId !== "string" ||
          !await (dependencies.activeSession ?? isActiveBrowserSession)(payload.browserSessionId))) return null;
    } else if (payload.tokenKind !== "internal") {
      return null;
    }
    return new Auth(EJSON.deserialize(payload));
  } catch (error) {
    // JWT failed
  }

  return null;
};

export function getAuthorizationHeader(
  req: { headers: Headers | { authorization?: string } },
): string | undefined {
  if ("get" in req.headers && typeof req.headers.get === "function") {
    return req.headers.get("authorization") ?? undefined;
  }

  return (req.headers as { authorization?: string }).authorization;
}

export const authenticate = async (
  req: { headers: Headers | { authorization?: string } },
): Promise<Auth | null> => {
  const authHeader = getAuthorizationHeader(req);

  if (!authHeader) {
    return null;
  }

  const token = /^Bearer\s+(\S+)$/i.exec(authHeader)?.[1];
  if (!token) {
    return null;
  }

  return verifyToken(token);
};

export const authenticateOr401 = async (
  req: Request,
  res: Response,
): Promise<Auth> => {
  const auth = await authenticate(req);

  if (!auth) {
    permissionDenied("Token is missing or invalid");
  }

  return auth;
};

export const getServerAuth = async (): Promise<Auth> => {
  const token = Deno.env.get("MYCELIA_JWT");
  if (token) {
    const auth = await verifyToken(token);
    if (auth) return auth;
    permissionDenied("Worker token is invalid or expired");
  }
  return getSystemAuth();
};

/** Internal server operations only; never use as a request-auth fallback. */
export function getSystemAuth(): Auth {
  return new Auth({
    principal: "server",
    policies: [{ resource: "**", action: "*", effect: "allow" }],
  });
}
