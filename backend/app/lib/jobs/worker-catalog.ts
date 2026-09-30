export type WorkerCatalogSection = "pipeline" | "maintenance" | "diagnostic";
export type WorkerExecutionKind = "backend" | "python-http" | "daemon";
export type WorkerRoutingKind = "none" | "stt" | "llm" | "diarizer";
export type WorkerAvailability =
  | "starting"
  | "ready"
  | "degraded"
  | "unavailable"
  | "daemon-managed";

export interface WorkerCatalogEntry {
  type: string;
  label: string;
  description: string;
  section: WorkerCatalogSection;
  order: number;
  executionKind: WorkerExecutionKind;
  routingKind: WorkerRoutingKind;
  availability: WorkerAvailability;
  registered: boolean;
  progressKind: string;
  capabilities: {
    manualRun: boolean;
    pause: boolean;
    schedule: boolean;
    concurrency: boolean;
    batchSize: boolean;
  };
}

type CatalogDefinition = Omit<
  WorkerCatalogEntry,
  "availability" | "registered"
>;

const pipeline = (
  type: string,
  label: string,
  description: string,
  order: number,
  options: Partial<CatalogDefinition> = {},
): CatalogDefinition => ({
  type,
  label,
  description,
  section: "pipeline",
  order,
  executionKind: "backend",
  routingKind: "none",
  progressKind: type,
  capabilities: {
    manualRun: true,
    pause: true,
    schedule: true,
    concurrency: true,
    batchSize: false,
  },
  ...options,
});

export const WORKER_CATALOG: readonly CatalogDefinition[] = [
  pipeline(
    "ingestion",
    "Ingestion",
    "Host-managed audio import. Run one bounded scan; automatic scheduling stays on the host.",
    0,
    {
      executionKind: "daemon",
      progressKind: "ingestion",
      capabilities: {
        manualRun: true,
        pause: false,
        schedule: false,
        concurrency: false,
        batchSize: false,
      },
    },
  ),
  pipeline("vad", "VAD", "Detects speech in audio chunks.", 10, {
    executionKind: "python-http",
  }),
  pipeline(
    "transcription_sequence_creator",
    "Sequence creator",
    "Groups speech chunks into ready transcription sequences.",
    20,
  ),
  pipeline(
    "transcription",
    "Transcription",
    "Transcribes ready sequences through configured STT routes.",
    30,
    { routingKind: "stt", progressKind: "transcription" },
  ),
  pipeline(
    "diarization",
    "Diarization",
    "Separates speakers through configured diarizer routes.",
    40,
    {
      executionKind: "python-http",
      routingKind: "diarizer",
      progressKind: "diarization",
    },
  ),
  pipeline(
    "speakerIdentity",
    "Speaker identity",
    "Classifies speech with the active calibrated voice profile.",
    50,
    { executionKind: "python-http", progressKind: "speaker-identity" },
  ),
  pipeline(
    "speakerMatching",
    "Speaker matching",
    "Matches stored speaker embeddings to known profiles.",
    60,
    { executionKind: "python-http", progressKind: "speaker-matching" },
  ),
  pipeline(
    "enrollment",
    "Enrollment",
    "Builds a speaker profile from labeled voice samples.",
    70,
    { executionKind: "python-http", progressKind: "enrollment" },
  ),
  pipeline(
    "profileReenrollment",
    "Profile reenrollment",
    "Rebuilds a profile from its saved voice samples.",
    80,
    { executionKind: "python-http", progressKind: "profile-reenrollment" },
  ),
  pipeline(
    "conversation_chunk_creator",
    "Chunk creator",
    "Groups transcriptions into conversation chunks; no LLM call.",
    90,
    { progressKind: "conversation-chunks" },
  ),
  pipeline(
    "conversation_extractor_merged",
    "Conversation extractor",
    "Extracts conversations and metadata with one LLM call per chunk.",
    100,
    { routingKind: "llm", progressKind: "conversation-extraction" },
  ),
  pipeline(
    "summarization",
    "Summarization",
    "Creates a title and summary for each conversation with an LLM.",
    110,
    { routingKind: "llm", progressKind: "summarization" },
  ),
  pipeline("tagger", "Tagger", "Backfills missing conversation tags.", 120, {
    routingKind: "llm",
    progressKind: "tagger",
  }),
  pipeline(
    "entity_typing",
    "Entity typing",
    "Backfills types for untyped objects.",
    130,
    { routingKind: "llm", progressKind: "entity-typing" },
  ),
  pipeline(
    "mediaFolderImport",
    "Media folder import",
    "Scans and imports one mounted photo-folder campaign with durable progress.",
    140,
    {
      progressKind: "media-folder-import",
      capabilities: {
        manualRun: false,
        pause: true,
        schedule: false,
        concurrency: false,
        batchSize: false,
      },
    },
  ),
  pipeline(
    "mediaRecognitionBatch",
    "Photo analysis batch",
    "Coordinates one confirmed photo-analysis batch with durable aggregate progress.",
    150,
    {
      progressKind: "media-recognition-batch",
      capabilities: {
        manualRun: false,
        pause: true,
        schedule: false,
        concurrency: false,
        batchSize: false,
      },
    },
  ),
  pipeline(
    "histRecalculation",
    "Timeline density",
    "Rebuilds stale or selected Timeline density ranges.",
    200,
    { section: "maintenance", progressKind: "timeline-rebuild" },
  ),
  pipeline(
    "objectListCatalogBackfill",
    "Object-list catalog",
    "Backfills and validates the object-list catalog.",
    210,
    { section: "maintenance", progressKind: "object-list-catalog" },
  ),
  pipeline(
    "objectTimelineDensityRebuild",
    "Object Timeline density",
    "Rebuilds and validates object Timeline density.",
    220,
    { section: "maintenance", progressKind: "object-timeline-density" },
  ),
  pipeline(
    "geonames_download",
    "GeoNames",
    "Downloads GeoNames data for offline place labels.",
    230,
    { section: "maintenance", progressKind: "geonames" },
  ),
  pipeline(
    "location_processing",
    "Location processing",
    "Builds movement and timezone records from GPS points.",
    240,
    { section: "maintenance", progressKind: "location-processing" },
  ),
  pipeline(
    "locationMapProjection",
    "Location map index",
    "Builds fast conversation clusters and source-aware route fragments.",
    245,
    { section: "maintenance", progressKind: "location-processing" },
  ),
  pipeline(
    "testPythonIntegration",
    "Python integration test",
    "Verifies execution through the Python worker.",
    300,
    {
      section: "diagnostic",
      executionKind: "python-http",
      progressKind: "diagnostic",
      capabilities: {
        manualRun: true,
        pause: false,
        schedule: false,
        concurrency: false,
        batchSize: false,
      },
    },
  ),
] as const;

export function buildWorkerCatalog(
  registeredTypes: Iterable<string>,
  options: { pythonCapabilities?: Iterable<string> | null } = {},
): WorkerCatalogEntry[] {
  const registered = new Set(registeredTypes);
  const pythonCapabilities = options.pythonCapabilities == null
    ? null
    : new Set(options.pythonCapabilities);
  return WORKER_CATALOG.map((definition) => {
    const isRegistered = registered.has(definition.type);
    const availability: WorkerAvailability = definition.executionKind ===
        "daemon"
      ? "daemon-managed"
      : !isRegistered
      ? registered.size === 0 ? "starting" : "unavailable"
      : definition.executionKind !== "python-http"
      ? "ready"
      : pythonCapabilities == null
      ? "starting"
      : pythonCapabilities.has(definition.type)
      ? "ready"
      : "unavailable";
    return {
      ...definition,
      registered: isRegistered,
      availability,
    };
  });
}

export function getWorkerCatalogEntry(type: string) {
  return WORKER_CATALOG.find((entry) => entry.type === type);
}
