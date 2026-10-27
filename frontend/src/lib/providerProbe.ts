import { callResource } from "@/lib/api";
export interface ProviderProbe {
  available: boolean;
  success: boolean;
  status?: number;
  latencyMs?: number;
  message: string;
}
/** Tests the existing health/models endpoint; does not generate a completion. */
export async function probeProviderConnection(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderProbe> {
  const result = await callResource("llm", {
    action: "probe",
    baseUrl: baseUrl.trim(),
    apiKey,
  });
  return {
    available: Boolean(result?.available),
    success: Boolean(result?.success),
    status: result?.status,
    latencyMs: result?.latencyMs,
    message: result?.message || "No response",
  };
}
