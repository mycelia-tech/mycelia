import type { Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "bson";
import { authenticate, getServerAuth } from "@/lib/auth/core.server.ts";
import { getMongoResource } from "@/lib/mongo/core.server.ts";
import { getRedisResource } from "@/lib/redis.ts";
import { signJWT } from "@/lib/auth/tokens.ts";
import YAML from "npm:yaml@2.6.1";
import { z } from "zod";
import type { Policy } from "@/lib/auth/resources.ts";
import { type RateLimitOptions, withRateLimit } from "@/utils/rateLimit.ts";
import { env } from "#/env.ts";
import {
  type CredentialBinding,
  credentialFingerprint,
  readCredential,
  validateCredentialBindings,
} from "@/lib/auth/credentials.ts";

const policySchema = z.object({
  resource: z.string(),
  action: z.string(),
  effect: z.enum(["allow", "deny"]),
});

const policiesArraySchema = z.array(policySchema).min(1).max(50);

function validateAndParsePolicies(
  scopeYaml: string,
): Array<{ resource: string; action: string; effect: "allow" | "deny" }> {
  try {
    const parsed = YAML.parse(scopeYaml);
    const validated = policiesArraySchema.parse(parsed);
    return validated;
  } catch (error) {
    throw new Error(
      `Invalid policy YAML: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }
}

export function isSuperuser(userPolicies: Policy[]): boolean {
  // Modifiers are restrictions too; dropping them here would let a filtered
  // credential mint unrestricted OAuth authority.
  return userPolicies.length === 1 &&
    userPolicies[0].effect === "allow" &&
    userPolicies[0].resource === "**" &&
    (userPolicies[0].action === "*" || userPolicies[0].action === "**");
}

function validateScopePermissions(userPolicies: Policy[]) {
  if (!isSuperuser(userPolicies)) {
    throw new Error("Only superusers can grant OAuth permissions.");
  }
}

const AUTH_CODE_PREFIX = "oauth:auth_code:";
const AUTH_CODE_TTL = 10 * 60; // 10 minutes in seconds
const CONSENT_REQUEST_PREFIX = "oauth:consent_request:";
const CONSENT_REQUEST_TTL = 5 * 60; // 5 minutes in seconds
const REFRESH_TOKEN_PREFIX = "oauth:refresh_token:";
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const PENDING_CLIENT_PREFIX = "oauth:pending_client:";

interface AuthorizationCodeData {
  clientId: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  scope: string;
  resource: string;
  userPrincipal: string;
  userPolicies: string;
  credentialBindings: string;
}

interface RefreshTokenData {
  clientId: string;
  userPrincipal: string;
  userPolicies: string;
  credentialBindings: CredentialBinding[];
  scope: string;
}

interface PendingClientData {
  clientId: string;
  clientSecretHash: string;
  openPrefix: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

export const oauthAuthorizeHandler = withRateLimit(
  {
    keyGenerator: (req) => `authorize:${req.query.client_id || "unknown"}`,
    limit: 10,
    windowSeconds: 60,
  },
  async (req: Request, res: Response) => {
    try {
      const {
        response_type,
        client_id,
        code_challenge,
        code_challenge_method,
        redirect_uri,
        state,
        scope,
        resource,
      } = req.query;

      const auth = await getServerAuth();
      const redis = await getRedisResource(auth);

      // Validate required parameters
      if (response_type !== "code") {
        res.status(400).json({
          error: "unsupported_response_type",
          error_description: "Only 'code' response type is supported",
        });
        return;
      }

      if (!client_id || typeof client_id !== "string") {
        res.status(400).json({
          error: "invalid_request",
          error_description: "client_id is required",
        });
        return;
      }

      if (!code_challenge || typeof code_challenge !== "string") {
        res.status(400).json({
          error: "invalid_request",
          error_description: "code_challenge is required (PKCE)",
        });
        return;
      }

      if (!redirect_uri || typeof redirect_uri !== "string") {
        res.status(400).json({
          error: "invalid_request",
          error_description: "redirect_uri is required",
        });
        return;
      }

      let clientName: string;
      let clientRedirectUris: string[];

      const pendingClientKey = `${PENDING_CLIENT_PREFIX}${client_id}`;
      const pendingClientDataRaw = await redis({
        action: "get",
        key: pendingClientKey,
      });

      if (pendingClientDataRaw) {
        const pendingClient = JSON.parse(
          pendingClientDataRaw as string,
        ) as PendingClientData;
        clientName = pendingClient.clientName;
        clientRedirectUris = pendingClient.redirectUris;
      } else {
        const mongo = await getMongoResource(auth);
        const clientDoc = await mongo({
          action: "findOne",
          collection: "api_keys",
          query: {
            _id: new ObjectId(client_id),
            isActive: true,
          },
        });

        if (!clientDoc) {
          res.status(400).json({
            error: "invalid_client",
            error_description: "Client not found or inactive",
          });
          return;
        }

        if (!clientDoc.redirectUris || !Array.isArray(clientDoc.redirectUris)) {
          res.status(400).json({
            error: "invalid_client",
            error_description: "Client has no registered redirect URIs",
          });
          return;
        }

        clientName = clientDoc.name || clientDoc.owner;
        clientRedirectUris = clientDoc.redirectUris;
      }

      if (!clientRedirectUris.includes(redirect_uri)) {
        res.status(400).json({
          error: "invalid_request",
          error_description: "redirect_uri does not match any registered URIs",
        });
        return;
      }

      const consentRequestId = randomBytes(32).toString("base64url");

      console.log({
        event: "oauth.authorize.consent_required",
        client_id,
        timestamp: new Date().toISOString(),
      });

      const consentRequestData = {
        clientId: client_id,
        clientName,
        codeChallenge: code_challenge as string,
        codeChallengeMethod: (code_challenge_method as string) || "S256",
        redirectUri: redirect_uri as string,
        scope: (scope as string) || "*",
        resource: (resource as string) || "",
        state: (state as string) || "",
      };

      const consentKey = `${CONSENT_REQUEST_PREFIX}${consentRequestId}`;

      await redis({
        action: "set",
        key: consentKey,
        value: JSON.stringify(consentRequestData),
        ttlSeconds: CONSENT_REQUEST_TTL,
      });

      const consentUrl = new URL(`${env.MYCELIA_FRONTEND_HOST}/oauth/consent`);
      consentUrl.searchParams.set("request_id", consentRequestId);

      res.redirect(consentUrl.toString());
    } catch (error) {
      console.error("OAuth authorization error:", error);
      res.status(500).json({
        error: "server_error",
        error_description: error instanceof Error
          ? error.message
          : "Unknown error",
      });
    }
  },
);

export async function oauthConsentDetailsHandler(req: Request, res: Response) {
  try {
    const userAuth = await authenticate(req);

    if (!userAuth) {
      res.status(401).json({
        error: "unauthorized",
        error_description: "Authentication required",
      });
      return;
    }

    const { request_id } = req.query;

    if (!request_id || typeof request_id !== "string") {
      res.status(400).json({
        error: "invalid_request",
        error_description: "request_id is required",
      });
      return;
    }

    const auth = await getServerAuth();
    const redis = await getRedisResource(auth);

    const consentKey = `${CONSENT_REQUEST_PREFIX}${request_id}`;
    const consentDataRaw = await redis({
      action: "get",
      key: consentKey,
    });

    if (!consentDataRaw) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Consent request not found or expired",
      });
      return;
    }

    const consentData = JSON.parse(consentDataRaw as string);

    res.json({
      client_id: consentData.clientId,
      client_name: consentData.clientName,
      scope: consentData.scope,
      redirect_uri: consentData.redirectUri,
    });
  } catch (error) {
    console.error("OAuth consent details error:", error);
    res.status(500).json({
      error: "server_error",
      error_description: error instanceof Error
        ? error.message
        : "Unknown error",
    });
  }
}

const oauthConsentRateLimitOptions = {
  keyGenerator: async (req: Request): Promise<string> => {
    const userAuth = await authenticate(req);
    return `consent:${userAuth?.principal || "unknown"}`;
  },
  limit: 20,
  windowSeconds: 60,
} satisfies RateLimitOptions;

export const oauthConsentHandler = withRateLimit(
  oauthConsentRateLimitOptions,
  async (req: Request, res: Response) => {
    try {
      const userAuth = await authenticate(req);

      if (!userAuth) {
        res.status(401).json({
          error: "unauthorized",
          error_description: "Authentication required",
        });
        return;
      }

      const auth = await getServerAuth();
      const redis = await getRedisResource(auth);

      const { request_id, approved, scope } = req.body;

      if (!request_id || typeof request_id !== "string") {
        res.status(400).json({
          error: "invalid_request",
          error_description: "request_id is required",
        });
        return;
      }

      if (typeof approved !== "boolean") {
        res.status(400).json({
          error: "invalid_request",
          error_description: "approved must be a boolean",
        });
        return;
      }

      const consentKey = `${CONSENT_REQUEST_PREFIX}${request_id}`;
      const consentDataRaw = await redis({
        action: "get",
        key: consentKey,
      });

      if (!consentDataRaw) {
        res.status(400).json({
          error: "invalid_request",
          error_description: "Consent request not found or expired",
        });
        return;
      }

      const consentData = JSON.parse(consentDataRaw as string);

      consentData.userPrincipal = userAuth.principal;
      consentData.userPolicies = JSON.stringify(userAuth.policies);
      consentData.credentialBindings = JSON.stringify(
        userAuth.credentialBindings ?? [],
      );

      if (scope && typeof scope === "string") {
        consentData.scope = scope;
      }

      await redis({
        action: "del",
        keys: [consentKey],
      });

      const redirectUrl = new URL(consentData.redirectUri);

      if (!approved) {
        console.log({
          event: "oauth.consent.denied",
          user: userAuth.principal,
          client_id: consentData.clientId,
          timestamp: new Date().toISOString(),
        });

        const pendingClientKey =
          `${PENDING_CLIENT_PREFIX}${consentData.clientId}`;
        await redis({
          action: "del",
          keys: [pendingClientKey],
        });

        redirectUrl.searchParams.set("error", "access_denied");
        redirectUrl.searchParams.set(
          "error_description",
          "User denied authorization",
        );
        if (consentData.state) {
          redirectUrl.searchParams.set("state", consentData.state);
        }

        res.json({ redirect_uri: redirectUrl.toString() });
        return;
      }

      try {
        validateScopePermissions(userAuth.policies);
      } catch (error) {
        console.log({
          event: "oauth.consent.unauthorized",
          user: userAuth.principal,
          client_id: consentData.clientId,
          error: error instanceof Error ? error.message : "Unknown error",
          timestamp: new Date().toISOString(),
        });

        res.status(403).json({
          error: "access_denied",
          error_description: error instanceof Error
            ? error.message
            : "Insufficient permissions to grant OAuth access",
        });
        return;
      }

      const pendingClientKey =
        `${PENDING_CLIENT_PREFIX}${consentData.clientId}`;
      const pendingClientDataRaw = await redis({
        action: "get",
        key: pendingClientKey,
      });

      if (pendingClientDataRaw) {
        const pendingClient = JSON.parse(
          pendingClientDataRaw as string,
        ) as PendingClientData;

        let policies;
        try {
          if (
            typeof consentData.scope === "string" && consentData.scope !== "*"
          ) {
            policies = validateAndParsePolicies(consentData.scope);
          } else {
            policies = [{ resource: "**", action: "*", effect: "allow" }];
          }
        } catch (error) {
          res.status(400).json({
            error: "invalid_scope",
            error_description: error instanceof Error
              ? error.message
              : "Invalid scope format",
          });
          return;
        }

        const mongo = await getMongoResource(auth);

        await mongo({
          action: "insertOne",
          collection: "api_keys",
          doc: {
            _id: ObjectId.createFromHexString(consentData.clientId),
            name: pendingClient.clientName,
            owner: userAuth.principal,
            openPrefix: pendingClient.openPrefix,
            hash: pendingClient.clientSecretHash,
            isActive: true,
            createdAt: new Date(pendingClient.createdAt * 1000),
            redirectUris: pendingClient.redirectUris,
            policies,
            policiesYaml: consentData.scope,
          },
        });

        await redis({
          action: "del",
          keys: [pendingClientKey],
        });
      }

      const authCode = randomBytes(32).toString("base64url");

      console.log({
        event: "oauth.consent.approved",
        user: userAuth.principal,
        client_id: consentData.clientId,
        scope: consentData.scope,
        timestamp: new Date().toISOString(),
      });

      const codeData: AuthorizationCodeData = {
        clientId: consentData.clientId,
        codeChallenge: consentData.codeChallenge,
        codeChallengeMethod: consentData.codeChallengeMethod,
        redirectUri: consentData.redirectUri,
        scope: consentData.scope,
        resource: consentData.resource,
        userPrincipal: consentData.userPrincipal,
        userPolicies: consentData.userPolicies,
        credentialBindings: consentData.credentialBindings,
      };

      const codeKey = `${AUTH_CODE_PREFIX}${authCode}`;

      await redis({
        action: "pipeline",
        operations: [
          {
            action: "hset",
            key: codeKey,
            field: "clientId",
            value: codeData.clientId,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "codeChallenge",
            value: codeData.codeChallenge,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "codeChallengeMethod",
            value: codeData.codeChallengeMethod,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "redirectUri",
            value: codeData.redirectUri,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "scope",
            value: codeData.scope,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "resource",
            value: codeData.resource,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "userPrincipal",
            value: codeData.userPrincipal,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "userPolicies",
            value: codeData.userPolicies,
            ttlSeconds: AUTH_CODE_TTL,
          },
          {
            action: "hset",
            key: codeKey,
            field: "credentialBindings",
            value: codeData.credentialBindings,
            ttlSeconds: AUTH_CODE_TTL,
          },
        ],
      });

      redirectUrl.searchParams.set("code", authCode);
      if (consentData.state) {
        redirectUrl.searchParams.set("state", consentData.state);
      }

      res.json({ redirect_uri: redirectUrl.toString() });
    } catch (error) {
      console.error("OAuth consent error:", error);
      res.status(500).json({
        error: "server_error",
        error_description: error instanceof Error
          ? error.message
          : "Unknown error",
      });
    }
  },
);

// Function to exchange authorization code for access token
interface TokenExchangeDependencies {
  redis?: Awaited<ReturnType<typeof getRedisResource>>;
  mongo?: Awaited<ReturnType<typeof getMongoResource>>;
  read?: typeof readCredential;
  sign?: typeof signJWT;
}

export async function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  codeVerifier: string,
  redirectUri: string,
  dependencies: TokenExchangeDependencies = {},
): Promise<
  { accessToken: string; refreshToken: string; expiresIn: number } | null
> {
  const codeKey = `${AUTH_CODE_PREFIX}${code}`;
  const auth = await getServerAuth();
  const redis = dependencies.redis ?? await getRedisResource(auth);

  const codeDataRaw = await redis({
    action: "hgetall",
    key: codeKey,
  });

  if (!codeDataRaw || Object.keys(codeDataRaw).length === 0) {
    return null; // Code not found or expired
  }

  const codeData = codeDataRaw as unknown as AuthorizationCodeData;

  if (codeData.clientId !== clientId) {
    return null; // Client ID mismatch
  }

  if (codeData.redirectUri !== redirectUri) {
    return null; // Redirect URI mismatch
  }

  const mongo = dependencies.mongo ?? await getMongoResource(auth);

  const clientDoc = await mongo({
    action: "findOne",
    collection: "api_keys",
    query: {
      _id: new ObjectId(clientId),
      isActive: true,
    },
  });

  if (!clientDoc) {
    return null;
  }

  if (!clientDoc.redirectUris || !Array.isArray(clientDoc.redirectUris)) {
    return null;
  }

  if (!clientDoc.redirectUris.includes(redirectUri)) {
    return null;
  }

  if (codeData.codeChallengeMethod === "S256") {
    const hash = createHash("sha256").update(codeVerifier).digest("base64url");
    if (hash !== codeData.codeChallenge) {
      return null; // Code verifier mismatch
    }
  } else if (codeData.codeChallengeMethod === "plain") {
    if (codeVerifier !== codeData.codeChallenge) {
      return null; // Code verifier mismatch
    }
  } else {
    return null; // Unsupported challenge method
  }

  if (!codeData.userPrincipal || !codeData.userPolicies) {
    return null;
  }

  if (!codeData.credentialBindings) return null;
  const sourceBindings = JSON.parse(
    codeData.credentialBindings,
  ) as CredentialBinding[];
  if (!Array.isArray(sourceBindings)) return null;
  const credentialBindings = [
    ...sourceBindings,
    { id: clientId, fingerprint: credentialFingerprint(clientDoc) },
  ];
  if (
    !await validateCredentialBindings(credentialBindings, dependencies.read)
  ) return null;
  // DEL is atomic. Only the request that consumes this grant may issue tokens,
  // even when two requests read and validate it concurrently.
  if (await redis({ action: "del", keys: [codeKey] }) !== 1) return null;
  // The registered client's approved permissions, never the administrator's
  // complete policies, are delegated to an OAuth client.
  const userPolicies = clientDoc.policies;

  // Generate access token (JWT) using the authenticated user's policies
  const jwt = await (dependencies.sign ?? signJWT)(
    codeData.userPrincipal,
    codeData.userPrincipal,
    userPolicies,
    "1 day",
    credentialBindings,
  );

  // Generate refresh token
  const refreshToken = randomBytes(32).toString("base64url");
  const refreshTokenKey = `${REFRESH_TOKEN_PREFIX}${refreshToken}`;

  const refreshTokenData: RefreshTokenData = {
    clientId: codeData.clientId,
    userPrincipal: codeData.userPrincipal,
    userPolicies: JSON.stringify(userPolicies),
    credentialBindings,
    scope: codeData.scope,
  };

  await redis({
    action: "set",
    key: refreshTokenKey,
    value: JSON.stringify(refreshTokenData),
    ttlSeconds: REFRESH_TOKEN_TTL,
  });

  return {
    accessToken: jwt,
    refreshToken,
    expiresIn: 86400, // 1 day
  };
}

export async function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  dependencies: TokenExchangeDependencies = {},
): Promise<
  { accessToken: string; refreshToken: string; expiresIn: number } | null
> {
  const refreshTokenKey = `${REFRESH_TOKEN_PREFIX}${refreshToken}`;
  const auth = await getServerAuth();
  const redis = dependencies.redis ?? await getRedisResource(auth);

  const refreshTokenDataRaw = await redis({
    action: "get",
    key: refreshTokenKey,
  });

  if (!refreshTokenDataRaw) {
    return null;
  }

  const refreshTokenData = JSON.parse(
    refreshTokenDataRaw as string,
  ) as RefreshTokenData;

  if (refreshTokenData.clientId !== clientId) {
    return null;
  }

  if (
    !await validateCredentialBindings(
      refreshTokenData.credentialBindings,
      dependencies.read,
    )
  ) return null;
  const currentClient = await (dependencies.read ?? readCredential)(clientId);
  if (!currentClient?.isActive) return null;

  if (await redis({ action: "del", keys: [refreshTokenKey] }) !== 1) {
    return null;
  }

  const userPolicies = currentClient.policies;

  const jwt = await (dependencies.sign ?? signJWT)(
    refreshTokenData.userPrincipal,
    refreshTokenData.userPrincipal,
    userPolicies,
    "1 day",
    refreshTokenData.credentialBindings,
  );

  const newRefreshToken = randomBytes(32).toString("base64url");
  const newRefreshTokenKey = `${REFRESH_TOKEN_PREFIX}${newRefreshToken}`;

  await redis({
    action: "set",
    key: newRefreshTokenKey,
    value: JSON.stringify(refreshTokenData),
    ttlSeconds: REFRESH_TOKEN_TTL,
  });

  return {
    accessToken: jwt,
    refreshToken: newRefreshToken,
    expiresIn: 86400,
  };
}
