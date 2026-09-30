import { LlmProviderLimiter } from "./provider-routing.ts";

/** Shared by text inference and photo analysis in the backend process. */
export const llmProviderLimiter = new LlmProviderLimiter();
