import type { Express } from "express";
import {
  healthHandler,
  readinessHandler,
  rootHandler,
} from "@/routes/health.ts";
import { setupHandler } from "@/routes/setup.ts";
import { dataAudioHandler } from "@/routes/data.audio.ts";
import { dataAudioItemsHandler } from "@/routes/data.audio.items.ts";
import { apiResourceHandler } from "@/routes/api.resource.$name.ts";
import { apiFilesIdHandler } from "@/routes/api.files.$id.ts";
import { apiFilesUploadHandler } from "@/routes/api.files.upload.ts";
import { apiAudioStreamHandler } from "@/routes/api.audio.stream.ts";
import { apiAudioUploadHandler } from "@/routes/api.audio.upload.ts";
import { apiLocationUploadHandler } from "@/routes/api.location.upload.ts";
import {
  apiLocationImportsAnalyzeHandler,
  apiLocationImportsConfirmHandler,
} from "@/routes/api.location.imports.ts";
import { apiMediaImportsAnalyzeHandler } from "@/routes/api.media.imports.ts";
import { apiAudioWavHandler } from "@/routes/api.audio.wav.ts";
import { mcpGetHandler, mcpPostHandler } from "@/routes/mcp.ts";
import { llmChatCompletionsHandler } from "@/routes/llm.chat.completions.ts";
import { transcriptionAudioHandler } from "@/routes/transcription.audio.ts";
import { oauthTokenHandler } from "@/routes/oauth.token.ts";
import { oauthRegisterHandler } from "@/routes/oauth.register.ts";
import {
  oauthAuthorizeHandler,
  oauthConsentDetailsHandler,
  oauthConsentHandler,
} from "@/routes/oauth.authorize.ts";
import { authJwtLoginHandler } from "@/routes/auth.jwt.login.ts";
import { wellKnownOauthAuthorizationServerHandler } from "@/routes/[.]well-known.oauth-authorization-server.ts";
import { wellKnownOauthProtectedResourceHandler } from "@/routes/[.]well-known.oauth-protected-resource.ts";
import { apiChatHandler } from "@/routes/api.chat.ts";
import { apiAudioPipelineHandler } from "@/routes/api.audio.pipeline.ts";
import { apiAudioPipelineLiveHandler } from "@/routes/api.audio.pipeline.live.ts";
import { apiAudioOperationsHandler } from "@/routes/api.audio.operations.ts";
import {
  apiAudioPipelineSourceDetailsHandler,
  apiAudioPipelineSourcesHandler,
} from "@/routes/api.audio.pipeline.sources.ts";
import { asyncHandler } from "@/middleware/asyncHandler.ts";
import { withRateLimit } from "@/utils/rateLimit.ts";

const uploadKeyGenerator = (req: any) =>
  `upload:${req.headers.authorization?.slice(-8) || "anon"}`;

export function registerRoutes(app: Express): void {
  app.get("/", rootHandler);
  app.get("/health", healthHandler);
  app.get("/readiness", readinessHandler);
  app.post("/api/setup", asyncHandler(setupHandler));
  app.get("/data/audio", dataAudioHandler);
  app.get("/data/audio/items", dataAudioItemsHandler);
  app.post("/api/resource/:name", asyncHandler(apiResourceHandler));
  app.post("/api/chat", asyncHandler(apiChatHandler));
  app.get("/api/audio/pipeline", asyncHandler(apiAudioPipelineHandler));
  app.get(
    "/api/audio/pipeline/operations",
    asyncHandler(apiAudioOperationsHandler),
  );
  app.get(
    "/api/audio/pipeline/live",
    asyncHandler(apiAudioPipelineLiveHandler),
  );
  app.get(
    "/api/audio/pipeline/sources",
    asyncHandler(apiAudioPipelineSourcesHandler),
  );
  app.get(
    "/api/audio/pipeline/sources/:id/details",
    asyncHandler(apiAudioPipelineSourceDetailsHandler),
  );
  app.get("/api/files/:id", apiFilesIdHandler);
  app.post(
    "/api/files/upload",
    withRateLimit(
      { keyGenerator: uploadKeyGenerator, limit: 20, windowSeconds: 60 },
      apiFilesUploadHandler,
    ),
  );
  app.get("/api/audio/stream", apiAudioStreamHandler);
  app.post(
    "/api/audio/upload",
    withRateLimit(
      { keyGenerator: uploadKeyGenerator, limit: 10, windowSeconds: 60 },
      apiAudioUploadHandler,
    ),
  );
  app.get("/api/audio/wav", apiAudioWavHandler);
  app.post(
    "/api/location/upload",
    withRateLimit(
      { keyGenerator: uploadKeyGenerator, limit: 10, windowSeconds: 60 },
      apiLocationUploadHandler,
    ),
  );
  app.post(
    "/api/location/imports/analyze",
    withRateLimit(
      { keyGenerator: uploadKeyGenerator, limit: 10, windowSeconds: 60 },
      apiLocationImportsAnalyzeHandler,
    ),
  );
  app.post(
    "/api/location/imports/:previewId/confirm",
    withRateLimit(
      { keyGenerator: uploadKeyGenerator, limit: 20, windowSeconds: 60 },
      apiLocationImportsConfirmHandler,
    ),
  );
  app.post(
    "/api/media/imports/analyze",
    withRateLimit(
      { keyGenerator: uploadKeyGenerator, limit: 10, windowSeconds: 60 },
      apiMediaImportsAnalyzeHandler,
    ),
  );
  app.get("/mcp", mcpGetHandler);
  app.post("/mcp", mcpPostHandler);
  app.post("/llm/chat/completions", llmChatCompletionsHandler);
  app.post("/v1/audio/transcriptions", transcriptionAudioHandler);
  app.get("/oauth/authorize", oauthAuthorizeHandler);
  app.get("/oauth/consent/details", oauthConsentDetailsHandler);
  app.post("/oauth/consent", oauthConsentHandler);
  app.post("/oauth/token", oauthTokenHandler);
  app.post("/oauth/register", oauthRegisterHandler);
  app.post("/auth/jwt/login", authJwtLoginHandler);
  app.get(
    "/.well-known/oauth-authorization-server",
    wellKnownOauthAuthorizationServerHandler,
  );
  app.get(
    "/.well-known/oauth-protected-resource",
    wellKnownOauthProtectedResourceHandler,
  );
}
