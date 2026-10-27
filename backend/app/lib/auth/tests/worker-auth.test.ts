import { expect } from "@std/expect";
import { withFixtures } from "@/tests/fixtures.server.ts";
import { getServerAuth, verifyToken } from "@/lib/auth/core.server.ts";
import { signJWT } from "@/lib/auth/tokens.ts";
import { Auth } from "@/lib/auth/core.server.ts";

Deno.test(
  "getServerAuth prioritizes MYCELIA_JWT if present",
  withFixtures([], async () => {
    const originalJwt = Deno.env.get("MYCELIA_JWT");
    const originalSecret = Deno.env.get("SECRET_KEY");
    try {
      if (!originalSecret) {
        Deno.env.set("SECRET_KEY", "test-secret-key-12345678901234567890");
      }
      // 1. Create a token
      const policies = [{ resource: "test", action: "read", effect: "allow" }] as any;
      const token = await signJWT("test-owner", "job:123", policies, "15m");
      
      // 2. Set environment variable
      Deno.env.set("MYCELIA_JWT", token);
      
      // 3. Call getServerAuth
      const auth = await getServerAuth();
      
      // 4. Verify auth reflects the token
      expect(auth.principal).toBe("job:123");
      expect(auth.policies).toEqual(policies);
    } finally {
      if (originalJwt) {
        Deno.env.set("MYCELIA_JWT", originalJwt);
      } else {
        Deno.env.delete("MYCELIA_JWT");
      }
    }
  }),
);

Deno.test(
  "getServerAuth refuses system permissions if MYCELIA_JWT is invalid",
  withFixtures([], async () => {
    const originalJwt = Deno.env.get("MYCELIA_JWT");
    try {
      // 1. Set an invalid token
      Deno.env.set("MYCELIA_JWT", "invalid-token");
      
      await expect(getServerAuth()).rejects.toBeInstanceOf(Response);
    } finally {
      if (originalJwt) {
        Deno.env.set("MYCELIA_JWT", originalJwt);
      } else {
        Deno.env.delete("MYCELIA_JWT");
      }
    }
  }),
);

Deno.test(
  "getServerAuth returns system permissions if MYCELIA_JWT is missing",
  withFixtures([], async () => {
    const originalJwt = Deno.env.get("MYCELIA_JWT");
    try {
      // 1. Ensure env var is missing
      Deno.env.delete("MYCELIA_JWT");
      
      // 2. Call getServerAuth
      const auth = await getServerAuth();
      
      // 3. Verify system permissions
      expect(auth.principal).toBe("server");
      expect(auth.policies).toEqual([{ resource: "**", action: "*", effect: "allow" }]);
    } finally {
      if (originalJwt) {
        Deno.env.set("MYCELIA_JWT", originalJwt);
      }
    }
  }),
);

