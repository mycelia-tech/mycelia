import type {
  MediaKnowledgeConfig,
  MediaRecognitionProfile,
  MediaRecognitionTask,
} from "@myceliasdk/media.ts";

export type GcpUsageSnapshot = {
  month: string;
  day: string;
  grossCommittedUsd: number;
  grossReservedUsd: number;
  grossMonthUsd: number;
  grossTodayUsd: number;
  monthlyLimitUsd: number;
  dailyLimitUsd: number | null;
  monthlyRemainingUsd: number;
  dailyRemainingUsd: number | null;
};

export const GOOGLE_VERTEX_VISUAL_SMOKE_GROSS_USD = 0.006;
export const GOOGLE_VISION_OCR_SMOKE_GROSS_USD = 0.0015;
export const GOOGLE_DOCUMENT_AI_SMOKE_GROSS_USD = 0.0015;
export const GOOGLE_QUERY_EMBEDDING_GROSS_USD = 0.0004;

export function estimateGoogleConnectorTestGrossUsd(
  includeDocumentAi: boolean,
): number {
  return GOOGLE_VERTEX_VISUAL_SMOKE_GROSS_USD +
    GOOGLE_VISION_OCR_SMOKE_GROSS_USD +
    (includeDocumentAi ? GOOGLE_DOCUMENT_AI_SMOKE_GROSS_USD : 0);
}

export function gcpUsageLedgerId(projectId: string, month: string): string {
  return `${projectId}:${month}`;
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function summarizeGcpUsage(
  usage: Record<string, unknown> | null,
  config: MediaKnowledgeConfig,
  now = new Date(),
): GcpUsageSnapshot {
  const month = now.toISOString().slice(0, 7);
  const day = now.toISOString().slice(0, 10);
  const grossCommittedUsd = finiteNonNegative(usage?.grossCommittedUsd);
  const grossReservedUsd = finiteNonNegative(usage?.grossReservedUsd);
  const grossMonthUsd = grossCommittedUsd + grossReservedUsd;
  const days = usage?.days && typeof usage.days === "object"
    ? usage.days as Record<string, { grossUsd?: unknown }>
    : {};
  const grossTodayUsd = finiteNonNegative(days[day]?.grossUsd);
  const monthlyLimitUsd = config.promoGuard.monthlyGrossLimitUsd;
  const dailyLimitUsd = config.promoGuard.dailyGrossLimitUsd;

  return {
    month,
    day,
    grossCommittedUsd,
    grossReservedUsd,
    grossMonthUsd,
    grossTodayUsd,
    monthlyLimitUsd,
    dailyLimitUsd,
    monthlyRemainingUsd: Math.max(0, monthlyLimitUsd - grossMonthUsd),
    dailyRemainingUsd: dailyLimitUsd === null
      ? null
      : Math.max(0, dailyLimitUsd - grossTodayUsd),
  };
}

export function estimateMediaGrossUsd(
  kind: "image" | "pdf",
  pageCount: number,
  tasks: MediaRecognitionTask[],
  profile: MediaRecognitionProfile,
): number {
  if (profile.providerType !== "google-cloud") return 0;
  if (kind === "pdf") {
    if (tasks.some((task) => task !== "ocr")) {
      throw new Error("PDF imports currently support only the OCR task");
    }
    return tasks.includes("ocr") ? pageCount * 0.0015 : 0;
  }
  return (tasks.includes("visual-understanding") ? 0.006 : 0) +
    (tasks.includes("ocr") ? 0.0015 : 0) +
    (tasks.includes("labels") ? 0.0015 : 0) +
    (tasks.includes("objects") ? 0.00225 : 0);
}

export function assertMediaPerImportBudget(
  config: MediaKnowledgeConfig,
  estimatedGrossUsd: number,
): void {
  if (estimatedGrossUsd > config.promoGuard.perImportGrossLimitUsd) {
    throw new Error(
      `Recognition estimate $${
        estimatedGrossUsd.toFixed(4)
      } for one asset exceeds the per-asset limit $${
        config.promoGuard.perImportGrossLimitUsd.toFixed(4)
      }`,
    );
  }
}

export function assertMediaItemsWithinPerImportBudget(
  config: MediaKnowledgeConfig,
  estimatedGrossUsdByItem: number[],
): void {
  for (const estimate of estimatedGrossUsdByItem) {
    assertMediaPerImportBudget(config, estimate);
  }
}
