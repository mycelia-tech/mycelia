import { z } from "zod";
import type { Request as ExpressRequest } from "express";

export const tokenRequestSchema = z.object({
  grant_type: z.literal("client_credentials"),
  client_secret: z.string(),
  client_id: z.string(),
});

export type TokenRequestInput = z.input<typeof tokenRequestSchema>;
export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export type ClientCredentials = {
  clientId: string;
  clientSecret: string;
  grantType: string | null;
  scope: string | null;
};

function parseBasicAuthHeader(
  header: string | null | undefined,
): { clientId: string; clientSecret: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const [id, secret] = decoded.split(":");
    if (!id || !secret) return null;
    return { clientId: id, clientSecret: secret };
  } catch {
    return null;
  }
}

function parseRequestParams(req: ExpressRequest): URLSearchParams {
  const contentType = req.headers["content-type"] || "";
  const params = new URLSearchParams();

  if (contentType.includes("application/x-www-form-urlencoded")) {
    // Express already parsed this into req.body
    for (const [k, v] of Object.entries(req.body || {})) {
      params.set(k, String(v));
    }
  } else if (contentType.includes("application/json")) {
    // Express already parsed this into req.body
    for (const [k, v] of Object.entries(req.body || {})) {
      params.set(k, String(v));
    }
  }

  return params;
}

export async function extractClientCredentials(
  req: ExpressRequest,
): Promise<ClientCredentials> {
  if (["client_secret", "password", "access_token", "token"].some((name) => req.query?.[name] !== undefined)) {
    return { clientId: "", clientSecret: "", grantType: null, scope: null };
  }
  const authHeader = req.headers.authorization;
  const basic = parseBasicAuthHeader(authHeader);
  const params = parseRequestParams(req);
  const grantType = params.get("grant_type") || "client_credentials";
  const scope = params.get("scope");
  const clientIdFromHeader = basic?.clientId || "";
  const clientSecretFromHeader = basic?.clientSecret || "";
  const clientIdFromBody = params.get("client_id") || params.get("username") ||
    "";
  const clientSecretFromBody = params.get("client_secret") ||
    params.get("password") || "";
  const clientId = clientIdFromBody || clientIdFromHeader;
  const clientSecret = clientSecretFromBody || clientSecretFromHeader;
  return { clientId, clientSecret, grantType, scope };
}

export type ErrorDetail = string | ErrorDetail[] | {
  [key: string]: ErrorDetail;
};

export function oauthErrorJson(
  detail: ErrorDetail,
  status = 400,
): Response {
  return Response.json({ error: detail }, { status });
}

export const authorizationServerMetadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  registration_endpoint: z.string().url(),
  grant_types_supported: z.array(
    z.union([
      z.literal("client_credentials"),
      z.literal("authorization_code"),
    ]),
  ),
  token_endpoint_auth_methods_supported: z.array(
    z.union([
      z.literal("client_secret_basic"),
      z.literal("client_secret_post"),
    ]),
  ),
  response_types_supported: z.array(z.string()),
  scopes_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

export type AuthorizationServerMetadata = z.infer<
  typeof authorizationServerMetadataSchema
>;

export function buildAuthorizationServerMetadata(
  origin: string,
): AuthorizationServerMetadata {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    grant_types_supported: ["client_credentials", "authorization_code"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    response_types_supported: ["code"],
    scopes_supported: ["*"],
    code_challenge_methods_supported: ["S256", "plain"],
  };
}

export const protectedResourceMetadataSchema = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()),
});

export type ProtectedResourceMetadata = z.infer<
  typeof protectedResourceMetadataSchema
>;

export function buildProtectedResourceMetadata(
  origin: string,
): ProtectedResourceMetadata {
  return {
    resource: origin,
    authorization_servers: [`${origin}/.well-known/oauth-authorization-server`],
  };
}
