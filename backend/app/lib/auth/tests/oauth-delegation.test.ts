import { expect } from "@std/expect";
import { ObjectId } from "bson";
import type { Policy } from "../resources.ts";
import { credentialFingerprint } from "../credentials.ts";
import {
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  isSuperuser,
} from "@/routes/oauth.authorize.ts";

const sourceId = "111111111111111111111111";
const clientId = "222222222222222222222222";
const rootPolicies: Policy[] = [{
  resource: "**",
  action: "*",
  effect: "allow",
}];
const clientPolicies: Policy[] = [{
  resource: "objects",
  action: "read",
  effect: "allow",
}];

Deno.test("OAuth delegation rejects a root allow constrained by a modifier", () => {
  expect(isSuperuser(rootPolicies)).toBe(true);
  expect(isSuperuser([{ resource: "*", action: "*", effect: "allow" }])).toBe(
    false,
  );
  expect(
    isSuperuser([...rootPolicies, {
      resource: "db/**",
      action: "*",
      effect: "modify",
      middleware: { code: "filter", arg: { filter: { owner: "restricted" } } },
    }]),
  ).toBe(false);
});

function grantFixture() {
  const source = { owner: "owner", policies: rootPolicies, isActive: true };
  const client = {
    _id: new ObjectId(clientId),
    owner: "owner",
    policies: clientPolicies,
    isActive: true,
    redirectUris: ["https://client.example/callback"],
  };
  const bindings = [{
    id: sourceId,
    fingerprint: credentialFingerprint(source),
  }, { id: clientId, fingerprint: credentialFingerprint(client) }];
  const entries = new Map<string, unknown>([
    ["oauth:auth_code:code", {
      clientId,
      redirectUri: client.redirectUris[0],
      codeChallengeMethod: "plain",
      codeChallenge: "verifier",
      userPrincipal: "owner",
      userPolicies: JSON.stringify(rootPolicies),
      credentialBindings: JSON.stringify([bindings[0]]),
      scope: "*",
    }],
    [
      "oauth:refresh_token:refresh",
      JSON.stringify({
        clientId,
        userPrincipal: "owner",
        userPolicies: JSON.stringify(clientPolicies),
        credentialBindings: bindings,
        scope: "*",
      }),
    ],
  ]);
  type Dependencies = NonNullable<
    Parameters<typeof exchangeAuthorizationCode>[4]
  >;
  const issued: { policies: Policy[]; bindings: unknown }[] = [];
  const dependencies: Dependencies = {
    redis: async (input) => {
      if (input.action === "get" || input.action === "hgetall") {
        return entries.get(input.key);
      }
      if (input.action === "del") {
        return input.keys.reduce(
          (count, key) => count + Number(entries.delete(key)),
          0,
        );
      }
      if (input.action === "set") {
        entries.set(input.key, input.value);
        return "OK";
      }
      throw new Error(`Unexpected Redis action: ${input.action}`);
    },
    mongo: async () => client,
    read: async (id) =>
      id === sourceId ? source : id === clientId ? client : null,
    sign: async (_owner, _principal, policies, _duration, bindings) => {
      issued.push({ policies, bindings });
      return "synthetic-token";
    },
  };
  return { dependencies, issued, bindings, source };
}

Deno.test("concurrent authorization-code exchange issues once and retains delegation bindings", async () => {
  const fixture = grantFixture();
  const attempts = await Promise.all(
    [1, 2].map(() =>
      exchangeAuthorizationCode(
        "code",
        clientId,
        "verifier",
        "https://client.example/callback",
        fixture.dependencies,
      )
    ),
  );
  expect(attempts.filter(Boolean).length).toBe(1);
  expect(fixture.issued).toEqual([{
    policies: clientPolicies,
    bindings: fixture.bindings,
  }]);
});

Deno.test("refresh-token rotation rejects concurrent replay", async () => {
  const fixture = grantFixture();
  const attempts = await Promise.all(
    [1, 2].map(() =>
      exchangeRefreshToken("refresh", clientId, fixture.dependencies)
    ),
  );
  expect(attempts.filter(Boolean).length).toBe(1);
  expect(fixture.issued).toEqual([{
    policies: clientPolicies,
    bindings: fixture.bindings,
  }]);
});

Deno.test("revoking the originating credential invalidates both OAuth grant paths", async () => {
  const fixture = grantFixture();
  fixture.source.isActive = false;
  expect(
    await exchangeAuthorizationCode(
      "code",
      clientId,
      "verifier",
      "https://client.example/callback",
      fixture.dependencies,
    ),
  ).toBeNull();
  expect(await exchangeRefreshToken("refresh", clientId, fixture.dependencies))
    .toBeNull();
  expect(fixture.issued).toEqual([]);
});
