import type { Request } from "express";
import type { Response as ExpressResponse } from "express";
import { authenticateOr401 } from "@/lib/auth/core.server.ts";
import { defaultResourceManager } from "@/lib/auth/resources.ts";
import { EJSON } from "bson";
import { requestCounter, tracer } from "@/lib/telemetry.ts";

export async function apiResourceHandler(req: Request, res: ExpressResponse) {
  const toolName = req.params.name;

  if (!toolName) {
    res.status(400).json({
      success: false,
      error: "Tool name is required",
    });
    return;
  }

  if (toolName === "chat") {
    res.setHeader("X-Mycelia-Request-Id", crypto.randomUUID());
  }

  return tracer.startActiveSpan(`api.resource.${toolName}`, async (span) => {
    try {
      span.setAttributes({
        "tool.name": toolName,
        "http.method": req.method,
        "http.url": req.url,
      });

      requestCounter.add(1, { tool: toolName, method: "POST" });

      const auth = await authenticateOr401(req, res);
      span.setAttributes({
        "auth.principal": auth.principal,
      });

      const body = req.body;
      const resource = defaultResourceManager.listResources().find((r) =>
        r.code === toolName
      );

      if (!resource) {
        span.setAttributes({
          "error": true,
          "error.message": `Tool '${toolName}' not found`,
        });
        res.status(404).json({
          success: false,
          error: `Tool '${toolName}' not found`,
        });
        return;
      }

      const run = defaultResourceManager.getResource(toolName, auth);

      // Express already parses JSON, so body is already an object
      // EJSON.deserialize handles BSON-extended JSON ($oid, $date, etc.) but is a no-op for regular JSON
      // The resource manager's validation will catch any schema issues
      const deserializedBody = EJSON.deserialize(body);

      let result: globalThis.Response | any = await run(deserializedBody);

      if (!(result instanceof globalThis.Response)) {
        result = EJSON.serialize(result);
      }

      span.setAttributes({
        "success": true,
      });

      if (result instanceof globalThis.Response) {
        // Convert Response to Express response
        const responseBody = await result.json();
        res.status(result.status).json(responseBody);
      } else {
        res.json(result);
      }
    } catch (error) {
      console.error(`[apiResourceHandler] resource ${toolName} error:`, error);
      if (error instanceof Error && error.message === "Unauthorized") {
        return; // Already sent 401 response
      }

      span.setAttributes({
        "error": true,
        "error.message": error instanceof Error ? error.message : String(error),
      });

      // Re-throw error to be handled by error middleware
      throw error;
    } finally {
      span.end();
    }
  });
}
