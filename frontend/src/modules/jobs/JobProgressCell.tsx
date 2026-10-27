import { format } from "date-fns";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { isEmptyJobResult } from "@/lib/jobEmptyResult";
import { parseJobError } from "@/lib/jobErrors";
import { getJobTimeRange } from "@/lib/jobTimeRange";
import { getDiarizationJobRoute } from "@/lib/jobRouting";
import {
  formatDiarizationWorkerRate,
  getCompletedDiarizationWorkerRate,
  getDiarizationProgressView,
} from "@/lib/diarizationProgress";
import { getSpeakerIdentityProgressView } from "@/lib/speakerIdentityProgress";
import {
  getMediaRecognitionBatchProgress,
  mediaRecognitionBatchStageLabel,
} from "@/lib/mediaRecognitionBatchProgress";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";
import type { JobInfo } from "@/types/jobs";

/**
 * States that carry a diagnosable reason. Queue maintenance cancels jobs it
 * reaps (timeout, queue_record_missing) instead of failing them, so "cancelled"
 * has to be grouped with "failed" wherever errors are shown or filtered.
 */
export const ERRORED_JOB_STATES: ReadonlySet<string> = new Set([
  "failed",
  "cancelled",
]);

function speakerIdentityProfileName(job: JobInfo): string {
  return String(
    job.data?.profileSnapshot?.name ?? job.data?.profileName ??
      job.result?.profileName ?? job.progress?.profileName ?? "selected voice",
  );
}

/**
 * Renders the worker's actual processed interval when available, falling back
 * to the requested job range for older/manual jobs.
 */
function JobDateRange({
  job,
  label,
  selectedProfileId,
}: {
  job: JobInfo;
  label?: string;
  selectedProfileId?: string | null;
}) {
  const range = getJobTimeRange(job);
  if (!range) return null;
  const { start, end } = range;
  const endTs = end ? end.getTime() : start.getTime() + 86400000;
  const isSameDay = end && start.toDateString() === end.toDateString();
  return (
    <Link
      to={withVoiceProfile(
        `/timeline?start=${start.getTime()}&end=${endTs}`,
        selectedProfileId,
      )}
      className="text-xs text-primary hover:underline"
      title={range.source === "processed"
        ? "Audio interval actually processed by this job"
        : "Time range requested for this job"}
    >
      {label ? `${label}: ` : ""}
      {isSameDay
        ? `${format(start, "yyyy-MM-dd HH:mm")}–${format(end, "HH:mm")}`
        : end
        ? `${format(start, "yyyy-MM-dd HH:mm")} — ${
          format(end, "yyyy-MM-dd HH:mm")
        }`
        : `from ${format(start, "yyyy-MM-dd HH:mm")}`}
    </Link>
  );
}

/**
 * Renders the Progress column content for a job row.
 * Handles all job types with type-specific displays.
 */
export function JobProgressCell({
  job,
  selectedProfileId,
}: {
  job: JobInfo;
  selectedProfileId?: string | null;
}) {
  const result = job.result || {};
  const progress = job.progress || {};
  // Treat as completed if state is completed, OR if active but result already populated
  const hasResult = job.result && typeof job.result === "object" &&
    Object.keys(job.result).length > 0;
  const isCompleted = job.state === "completed" ||
    (job.state === "active" && hasResult);
  const isActive = job.state === "active" && !hasResult;

  // --- Durable photo recognition batch ---
  if (job.type === "mediaRecognitionBatch") {
    const storedProgress = Object.keys(progress).length > 0
      ? progress
      : (result.progress ?? {});
    const view = getMediaRecognitionBatchProgress({
      status: storedProgress.status ?? storedProgress.stage ?? job.state,
      progress: storedProgress,
      counts: storedProgress.counts ?? result.counts,
    });
    const progressText = `${view.done} of ${view.total} photos complete`;
    return (
      <div className="min-w-[260px] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            {mediaRecognitionBatchStageLabel(view.stage)}
          </Badge>
          <Link
            to="/media/analysis"
            className="text-xs text-primary hover:underline"
          >
            Open photo analysis
          </Link>
        </div>
        <Progress
          value={view.percent}
          className="h-1.5"
          aria-label="Photo analysis batch progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent}
          aria-valuetext={progressText}
        />
        <div
          className="flex justify-between gap-3 text-[11px] text-muted-foreground"
          aria-live="polite"
          aria-atomic="true"
        >
          <span>{view.done}/{view.total} photos complete</span>
          <span>{view.percent.toFixed(1)}%</span>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>pending {view.pending}</span>
          <span>queued {view.queued}</span>
          <span>processing {view.processing}</span>
          <span className={view.failed > 0 ? "text-red-500" : undefined}>
            failed {view.failed}
          </span>
        </div>
      </div>
    );
  }

  // --- Failed and cancelled jobs: show parsed error ---
  // Queue maintenance cancels jobs (timeout, queue_record_missing) rather than
  // failing them, so gating on "failed" alone hides the only clue about why a
  // job stopped.
  if (ERRORED_JOB_STATES.has(job.state) && job.failedReason) {
    const error = parseJobError(job.failedReason);
    if (error) {
      return (
        <div className="space-y-1">
          <Badge
            variant="secondary"
            className="bg-red-500/10 text-red-500 text-xs"
          >
            {error.label}
          </Badge>
          <div
            className="text-xs text-red-400/80 truncate max-w-[250px]"
            title={error.detail}
          >
            {error.detail}
          </div>
        </div>
      );
    }
  }

  // --- Transcription ---
  if (job.type === "transcription") {
    if (isCompleted) {
      const isEmpty = result.result === "empty" ||
        (result.wordCount != null && result.wordCount === 0) ||
        (result.processed === 0 && !result.transcriptionId);
      if (isEmpty) {
        // Use sequenceStart from result, progress, or fall back to job creation time
        const seqStart = result.sequenceStart || progress.sequenceStart ||
          (job.timestamp ? new Date(job.timestamp).toISOString() : null);
        return (
          <div className="space-y-1">
            <Badge
              variant="secondary"
              className="bg-amber-500/10 text-amber-500 text-xs"
            >
              Empty
            </Badge>
            {seqStart && (
              <Link
                to={withVoiceProfile(
                  `/timeline?start=${new Date(seqStart).getTime()}&end=${
                    new Date(seqStart).getTime() +
                    (result.audioDuration || 60) * 1000 + 60000
                  }`,
                  selectedProfileId,
                )}
                className="text-xs text-primary hover:underline"
              >
                {format(new Date(seqStart), "MMM d, HH:mm")}
              </Link>
            )}
          </div>
        );
      }
      return (
        <div className="space-y-1">
          {result.sequenceStart && (
            <Link
              to={withVoiceProfile(
                `/timeline?start=${
                  new Date(result.sequenceStart).getTime()
                }&end=${
                  new Date(result.sequenceStart).getTime() +
                  (result.audioDuration || 60) * 1000 + 60000
                }`,
                selectedProfileId,
              )}
              className="text-xs text-primary hover:underline"
            >
              {format(new Date(result.sequenceStart), "MMM d, HH:mm")}
            </Link>
          )}
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.audioDuration != null && (
              <span>{result.audioDuration.toFixed(1)}s audio</span>
            )}
            {Number(result.inferenceMs) > 0 && result.audioDuration > 0 && (
              <span>
                {(result.inferenceMs / 1000).toFixed(1)}s STT · {(
                  result.audioDuration / (result.inferenceMs / 1000)
                ).toFixed(2)}× realtime
              </span>
            )}
            {result.wordCount != null
              ? <span>{result.wordCount} words</span>
              : <span className="opacity-50">— words</span>}
            {result.segmentCount != null && (
              <span>{result.segmentCount} segments</span>
            )}
            {result.batchSize != null && (
              <span>{result.processed ?? 0}/{result.batchSize} in batch</span>
            )}
            {result.hasMore && <span className="text-amber-400">has more</span>}
          </div>
          {result.textPreview && (
            <div
              className="text-xs text-muted-foreground/70 truncate max-w-[250px]"
              title={result.textPreview}
            >
              {result.textPreview}
            </div>
          )}
        </div>
      );
    }
    if (progress.stage) {
      const stageLabels: Record<string, string> = {
        processing: "Processing",
        fetching_chunks: "Fetching chunks",
        combining_audio: "Combining audio",
        transcribing: "Transcribing",
        saving_result: "Saving",
        empty_result: "Empty result",
        completed: "Finishing",
        batch_starting: "Starting batch",
        idle: "Idle",
      };
      return (
        <div className="space-y-1">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            {stageLabels[progress.stage] ?? progress.stage}
          </Badge>
          {progress.sequenceStart && (
            <Link
              to={withVoiceProfile(
                `/timeline?start=${
                  new Date(progress.sequenceStart).getTime()
                }&end=${new Date(progress.sequenceStart).getTime() + 120000}`,
                selectedProfileId,
              )}
              className="text-xs text-primary hover:underline"
            >
              {format(new Date(progress.sequenceStart), "MMM d, HH:mm")}
            </Link>
          )}
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {progress.chunkCount != null && (
              <span>{progress.chunkCount} chunks</span>
            )}
            {progress.audioSize != null && (
              <span>{(progress.audioSize / 1024).toFixed(0)} KB</span>
            )}
            {progress.duration != null && (
              <span>{progress.duration.toFixed(1)}s audio</span>
            )}
            {progress.batchSize != null && (
              <span>
                {progress.processedInBatch ?? 0}/{progress.batchSize} batch
              </span>
            )}
            {progress.prefetch?.state && (
              <span>
                prefetch {String(progress.prefetch.state).replaceAll("_", " ")}
              </span>
            )}
            {progress.audioPreparationMs != null && (
              <span>prep {progress.audioPreparationMs}ms</span>
            )}
            {progress.prefetchWaitMs != null && (
              <span>wait {progress.prefetchWaitMs}ms</span>
            )}
          </div>
        </div>
      );
    }
  }

  // --- VAD ---
  if (job.type === "vad") {
    if (isCompleted) {
      if ((result.hasSpeech ?? 0) === 0 && (result.processed ?? 0) === 0) {
        return (
          <Badge
            variant="secondary"
            className="bg-muted text-muted-foreground text-xs"
            title="Scheduled safety check found no unassigned transcriptions or stale chunks"
          >
            No work due
          </Badge>
        );
      }
      return (
        <div className="space-y-1">
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.processed != null && result.total != null && (
              <span>{result.processed}/{result.total} processed</span>
            )}
            {result.hasSpeech != null && (
              <span>{result.hasSpeech} with speech</span>
            )}
            {result.duration != null && (
              <span>{result.duration.toFixed(1)}s</span>
            )}
            {result.hasMore && <span className="text-amber-400">has more</span>}
          </div>
        </div>
      );
    }
    if (isActive && progress) {
      return (
        <div className="space-y-1">
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {progress.processed != null && progress.total != null && (
              <span>{progress.processed}/{progress.total} processed</span>
            )}
            {progress.hasSpeech != null && (
              <span>{progress.hasSpeech} with speech</span>
            )}
          </div>
          {progress.currentTimestamp && (
            <div className="text-xs text-muted-foreground/70">
              at {format(new Date(progress.currentTimestamp), "MMM d, HH:mm")}
            </div>
          )}
        </div>
      );
    }
  }

  // --- Conversation Chunk Creator ---
  if (job.type === "conversation_chunk_creator") {
    if (isCompleted) {
      if (
        (result.finalized ?? 0) === 0 && (result.streamed ?? 0) === 0 &&
        (result.chunksCreated ?? 0) === 0
      ) {
        return (
          <Badge
            variant="secondary"
            className="bg-amber-500/10 text-amber-500 text-xs"
          >
            Empty
          </Badge>
        );
      }
      return (
        <div className="space-y-1">
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.chunksCreated != null && (
              <span>{result.chunksCreated} chunks</span>
            )}
            {result.finalized != null && (
              <span>{result.finalized} finalized</span>
            )}
            {result.streamed != null && result.streamed > 0 && (
              <span>{result.streamed} streamed</span>
            )}
            {result.backfilled != null && result.backfilled > 0 && (
              <span>{result.backfilled} backfilled</span>
            )}
            {result.hasMore && <span className="text-amber-400">has more</span>}
          </div>
        </div>
      );
    }
    if (isActive && progress.stage) {
      const stageLabels: Record<string, string> = {
        finalizing_stale: "Finalizing",
        streaming: "Streaming",
        backfilling: "Backfilling",
      };
      return (
        <div className="space-y-1">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            {stageLabels[progress.stage] ?? progress.stage}
          </Badge>
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {progress.finalized != null && (
              <span>{progress.finalized} finalized</span>
            )}
            {progress.streamed != null && (
              <span>{progress.streamed} streamed</span>
            )}
          </div>
        </div>
      );
    }
  }

  // --- Conversation Extractor ---
  if (job.type === "conversation_extractor") {
    if (isCompleted) {
      if (
        (result.conversationsCreated ?? 0) === 0 &&
        (result.chunksProcessed ?? 0) === 0
      ) {
        return (
          <Badge
            variant="secondary"
            className="bg-muted text-muted-foreground text-xs"
            title="No conversation chunks were ready to process"
          >
            Idling
          </Badge>
        );
      }
      return (
        <div className="space-y-1">
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          {(result.chunksProcessed ?? 0) > 0 &&
            (result.conversationsCreated ?? 0) === 0 && (
            <Badge
              variant="secondary"
              className="bg-sky-500/10 text-sky-500 text-xs"
              title="The chunk was reviewed and saved as having no usable conversation"
            >
              Reviewed · no conversation
            </Badge>
          )}
          {result.description && (
            <div
              className="max-w-xl truncate text-xs text-foreground"
              title={result.description}
            >
              {result.description}
            </div>
          )}
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.conversationsCreated != null && (
              <span>{result.conversationsCreated} conversations</span>
            )}
            {result.chunksProcessed != null && (
              <span>{result.chunksProcessed} chunks</span>
            )}
            {result.segmentsFound != null
              ? (
                <>
                  <span>{result.segmentsFound} segments</span>
                  <span>{result.emojiCount ?? 0} emoji</span>
                  <span>{result.entityCount ?? 0} entities</span>
                  <span>
                    {result.relationshipsCreated ?? 0}/
                    {result.relationshipsAttempted ?? 0} links
                  </span>
                  <span>{result.agreementCount ?? 0} agreements</span>
                  <span
                    className={(result.relationshipErrors ?? 0) > 0
                      ? "text-red-400"
                      : undefined}
                  >
                    {result.relationshipErrors ?? 0} link errors
                  </span>
                </>
              )
              : <span>legacy result: extraction counts unavailable</span>}
            {result.errors?.length > 0 && (
              <span className="text-red-400">
                {result.errors.length} errors
              </span>
            )}
            {result.hasMore && <span className="text-amber-400">has more</span>}
          </div>
        </div>
      );
    }
    if (progress.stage) {
      const stageLabels: Record<string, string> = {
        processing_chunk: "Processing chunk",
        segmenting: "Segmenting",
        extracting_metadata: "Extracting metadata",
      };
      return (
        <div className="space-y-1">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            {stageLabels[progress.stage] ?? progress.stage}
          </Badge>
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {progress.chunksProcessed != null && (
              <span>{progress.chunksProcessed} chunks</span>
            )}
            {progress.totalSegments != null && (
              <span>
                {progress.segment ?? 0}/{progress.totalSegments} segments
              </span>
            )}
            {progress.entityCount != null && (
              <span>{progress.entityCount} entities</span>
            )}
            {progress.emojiCount != null && (
              <span>{progress.emojiCount} emoji</span>
            )}
            {progress.relationshipsCreated != null && (
              <span>{progress.relationshipsCreated} links</span>
            )}
            {progress.agreementCount != null && (
              <span>{progress.agreementCount} agreements</span>
            )}
          </div>
        </div>
      );
    }
  }

  // --- Transcription Sequence Creator ---
  if (job.type === "transcription_sequence_creator") {
    if (isCompleted) {
      if ((result.processed ?? 0) === 0) {
        return (
          <Badge
            variant="secondary"
            className="bg-amber-500/10 text-amber-500 text-xs"
          >
            Empty
          </Badge>
        );
      }
      return (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{result.processed} processed</span>
          {result.hasMore && <span className="text-amber-400">has more</span>}
        </div>
      );
    }
    if (progress.processed != null || progress.sequencesCreated != null) {
      return (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          {progress.processed != null && (
            <span>{progress.processed} processed</span>
          )}
          {progress.sequencesCreated != null && (
            <span>{progress.sequencesCreated} sequences</span>
          )}
        </div>
      );
    }
  }

  // --- Tagger ---
  if (job.type === "tagger") {
    if (isCompleted) {
      return (
        <div className="space-y-1">
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.conversationsProcessed != null && (
              <span>{result.conversationsProcessed} conversations</span>
            )}
            {result.tagsApplied != null && (
              <span>{result.tagsApplied} tags</span>
            )}
            {result.errors?.length > 0 && (
              <span className="text-red-400">
                {result.errors.length} errors
              </span>
            )}
            {result.hasMore && <span className="text-amber-400">has more</span>}
          </div>
        </div>
      );
    }
    if (isActive && progress) {
      return (
        <div className="space-y-1">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            Tagging
          </Badge>
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {progress.current != null && progress.total != null && (
              <span>{progress.current}/{progress.total}</span>
            )}
          </div>
        </div>
      );
    }
  }

  // --- Summarization ---
  if (job.type === "summarization") {
    if (isCompleted) {
      if (!result.success) {
        return (
          <div className="space-y-1">
            <Badge
              variant="secondary"
              className="bg-red-500/10 text-red-500 text-xs"
            >
              Failed
            </Badge>
            {result.message && (
              <div className="text-xs text-red-400 truncate max-w-[200px]">
                {result.message}
              </div>
            )}
          </div>
        );
      }
      const batchSummaries = Array.isArray(result.summaries)
        ? result.summaries.filter((summary: any) => summary?.objectId)
        : [];
      if (batchSummaries.length > 0) {
        return (
          <div className="space-y-1">
            <Badge
              variant="secondary"
              className="bg-violet-500/10 text-violet-600 text-xs"
            >
              Batch summarization
            </Badge>
            <div className="text-xs text-muted-foreground">
              {batchSummaries.length}{" "}
              summar{batchSummaries.length === 1 ? "y" : "ies"} created
            </div>
            <Link
              to={withVoiceProfile(`/jobs/${job.id}`, selectedProfileId)}
              className="text-xs text-primary hover:underline"
            >
              view conversations
            </Link>
          </div>
        );
      }
      // Auto batch that found nothing to summarize: no LLM was called.
      if (result.processed === 0 && !result.objectId && !result.inference) {
        return (
          <div className="space-y-1">
            <Badge
              variant="secondary"
              className="bg-amber-500/10 text-amber-500 text-xs"
            >
              Empty
            </Badge>
            <div className="text-xs text-muted-foreground">
              {result.message || "No conversations missing summaries"}{" "}
              · no LLM calls
            </div>
          </div>
        );
      }
      const start = result.start ? new Date(result.start) : null;
      const end = result.end ? new Date(result.end) : null;
      return (
        <div className="space-y-1">
          {start && end && (
            <Link
              to={withVoiceProfile(
                `/timeline?start=${start.getTime()}&end=${end.getTime()}`,
                selectedProfileId,
              )}
              className="text-xs text-primary hover:underline"
            >
              {format(start, "MMM d, HH:mm")} — {format(end, "HH:mm")}
            </Link>
          )}
          {result.title && (
            <div
              className="text-xs text-muted-foreground truncate max-w-[200px]"
              title={result.title}
            >
              {result.title}
            </div>
          )}
          {result.objectId && (
            <Link
              to={`/objects/${result.objectId}`}
              className="text-xs text-primary hover:underline"
            >
              view conversation
            </Link>
          )}
        </div>
      );
    }
  }

  // --- Diarization ---
  if (job.type === "diarization") {
    if (isCompleted) {
      const diarizationErrorCount = result.errorCount ??
        (Array.isArray(result.errors) ? result.errors.length : result.errors) ??
        0;
      const finalWorkerRateLabel = formatDiarizationWorkerRate(
        getCompletedDiarizationWorkerRate(
          result,
          job.processedOn,
          job.finishedOn,
        ),
      );
      if (result.message && (result.sequences_processed ?? 0) === 0) {
        return (
          <span className="text-xs text-muted-foreground">
            {result.message}
          </span>
        );
      }
      return (
        <div className="space-y-1">
          <JobDateRange
            job={job}
            label="Audio"
            selectedProfileId={selectedProfileId}
          />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.sequences_processed != null && (
              <span>{result.sequences_processed} sequences</span>
            )}
            {result.chunks_processed != null && (
              <span>{result.chunks_processed} chunks</span>
            )}
            {result.segments_created != null && (
              <span>{result.segments_created} segments</span>
            )}
            {finalWorkerRateLabel && (
              <span className="font-medium text-foreground">
                {finalWorkerRateLabel}
              </span>
            )}
            {diarizationErrorCount > 0 && (
              <span className="text-red-400">
                {diarizationErrorCount} errors
              </span>
            )}
          </div>
        </div>
      );
    }
    if (isActive && progress.stage) {
      const stageLabels: Record<string, string> = {
        counting: "Preparing backlog",
        processing: "Processing",
      };
      const progressView = getDiarizationProgressView(progress);
      const routeName = getDiarizationJobRoute(job)?.name;
      return (
        <div className="min-w-[220px] space-y-2">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            {stageLabels[progress.stage] ?? progress.stage}
          </Badge>
          <JobDateRange
            job={job}
            label="Audio"
            selectedProfileId={selectedProfileId}
          />
          {progressView.batchProgressLabel && (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>This batch</span>
                {routeName && (
                  <span className="normal-case tracking-normal">
                    {routeName}
                  </span>
                )}
              </div>
              {progressView.batchPercent != null && (
                <Progress
                  value={progressView.batchPercent}
                  className="h-1.5"
                />
              )}
              <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span>{progressView.batchProgressLabel}</span>
                {progressView.batchChunksLabel && (
                  <span>{progressView.batchChunksLabel}</span>
                )}
              </div>
              {progressView.workerRateLabel && (
                <div className="text-[11px] font-medium text-foreground">
                  {progressView.workerRateLabel}
                </div>
              )}
            </div>
          )}
          {!progressView.batchProgressLabel &&
            typeof progress.message === "string" && progress.message && (
            <div className="text-[11px] text-foreground">
              <span className="font-medium">This batch:</span>{" "}
              {progress.message}
            </div>
          )}
          {progress.stage === "counting" && (
            <p className="text-[11px] text-muted-foreground">
              Exact count is bounded to 5s; processing continues if it times
              out.
            </p>
          )}
        </div>
      );
    }
  }

  // --- Hist Recalculation ---
  if (job.type === "histRecalculation") {
    if (isCompleted) {
      return (
        <div className="space-y-1">
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.processed != null && (
              <span>{result.processed} processed</span>
            )}
            {result.marked != null && <span>{result.marked} marked stale</span>}
            {result.hasMore && <span className="text-amber-400">has more</span>}
          </div>
        </div>
      );
    }
  }

  // --- Speaker Identity ---
  if (job.type === "speakerIdentity") {
    const profileName = speakerIdentityProfileName(job);
    if (isCompleted) {
      return (
        <div className="space-y-1">
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{result.processed ?? 0} scanned</span>
            <span className="text-green-500">
              {result.matched ?? 0} {profileName}
            </span>
            <span>{result.rejected ?? 0} not {profileName}</span>
            <span className="text-amber-500">
              {result.uncertain ?? 0} uncertain
            </span>
            {(result.incompatibleSkipped ?? 0) > 0 && (
              <span>{result.incompatibleSkipped} incompatible</span>
            )}
            {result.hasMore && (
              <span className="text-blue-500">next batch queued</span>
            )}
          </div>
          {result.campaignId && (
            <div className="text-[11px] text-muted-foreground">
              Campaign {result.campaignProcessed ?? result.processed ?? 0}/
              {result.campaignTotal ?? "?"} · {result.campaignMatched ?? 0}{" "}
              {profileName} · {result.campaignRejected ?? 0} not {profileName} ·
              {" "}
              {result.campaignUncertain ?? 0} uncertain
            </div>
          )}
        </div>
      );
    }
    if (isActive && progress.stage) {
      const view = getSpeakerIdentityProgressView({
        processed: progress.processed,
        total: progress.total,
        remaining: progress.remaining,
        segmentsPerSecond: progress.segmentsPerSecond,
        etaSeconds: progress.etaSeconds,
      });
      return (
        <div className="min-w-[240px] space-y-2">
          <Badge
            variant="secondary"
            className="bg-violet-500/10 text-violet-500 text-xs"
          >
            {progress.stage === "counting"
              ? "Counting embeddings"
              : "Classifying voices"}
          </Badge>
          <JobDateRange job={job} selectedProfileId={selectedProfileId} />
          {progress.total != null && (
            <Progress value={view.percent} className="h-1.5" />
          )}
          <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{view.progressLabel}</span>
            <span>{view.etaLabel}</span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="text-green-500">
              {progress.matched ?? 0} {profileName}
            </span>
            <span>{progress.rejected ?? 0} not {profileName}</span>
            <span className="text-amber-500">
              {progress.uncertain ?? 0} uncertain
            </span>
            {(progress.incompatibleSkipped ?? 0) > 0 && (
              <span>{progress.incompatibleSkipped} incompatible</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {view.remainingLabel}
            {view.rateLabel
              ? `${view.remainingLabel ? " · " : ""}${view.rateLabel}`
              : ""}
            {progress.batchNumber
              ? ` · batch ${progress.batchNumber}/${
                progress.estimatedBatches ?? "?"
              }`
              : ""}
          </p>
        </div>
      );
    }
  }

  // --- Speaker Matching (legacy) ---
  if (job.type === "speakerMatching") {
    if (isCompleted) {
      return (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.processed != null && (
              <span>{result.processed} processed</span>
            )}
            {result.matched != null && <span>{result.matched} matched</span>}
            {result.profiles_count != null && (
              <span>{result.profiles_count} profiles</span>
            )}
            {result.duration != null && (
              <span>{result.duration.toFixed(1)}s</span>
            )}
            {result.has_more && (
              <span className="text-amber-400">has more</span>
            )}
          </div>
        </div>
      );
    }
    if (isActive && progress) {
      const stageLabels: Record<string, string> = {
        loading_profiles: "Loading profiles",
        loading_segments: "Loading segments",
        matching: "Matching",
      };
      return (
        <div className="space-y-1">
          {progress.stage && (
            <Badge
              variant="secondary"
              className="bg-blue-500/10 text-blue-500 text-xs"
            >
              {stageLabels[progress.stage] ?? progress.stage}
            </Badge>
          )}
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {progress.processed != null && progress.total != null && (
              <span>{progress.processed}/{progress.total}</span>
            )}
            {progress.matched != null && (
              <span>{progress.matched} matched</span>
            )}
          </div>
        </div>
      );
    }
  }

  // --- Mounted photo folder campaign ---
  if (job.type === "mediaFolderImport") {
    const folderProgress = Object.keys(progress).length > 0
      ? progress
      : (result.progress ?? {});
    const processed = Number(folderProgress.processed ?? 0);
    const total = Number(folderProgress.total ?? 0);
    const discovering = folderProgress.totalKnown === false;
    const percent = Number.isFinite(Number(folderProgress.percent))
      ? Number(folderProgress.percent)
      : total > 0
      ? processed / total * 100
      : 0;
    const etaSeconds = Number(folderProgress.etaSeconds);
    const eta = Number.isFinite(etaSeconds) && etaSeconds >= 0
      ? etaSeconds < 60
        ? `${Math.ceil(etaSeconds)}s`
        : etaSeconds < 3_600
        ? `${Math.ceil(etaSeconds / 60)} min`
        : `${Math.floor(etaSeconds / 3_600)}h ${
          Math.ceil((etaSeconds % 3_600) / 60)
        }m`
      : undefined;
    const stageLabels: Record<string, string> = {
      inventory: "Building inventory",
      metadata_scan: "Scanning metadata",
      awaiting_confirmation: "Ready to review",
      creating_previews: "Creating previews",
      completed: "Finished",
      failed: "Failed",
      cancelled: "Cancelled",
    };
    return (
      <div className="min-w-[240px] space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            {folderProgress.waitingForRecovery
              ? "Waiting for recovery"
              : stageLabels[String(folderProgress.stage)] ??
                (isCompleted ? "Finished" : "Working")}
          </Badge>
          <Link to="/media" className="text-xs text-primary hover:underline">
            Open Media
          </Link>
        </div>
        {total > 0 && (
          <Progress
            value={discovering ? undefined : percent}
            className="h-1.5"
          />
        )}
        <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
          <span>
            {discovering
              ? `${processed} files discovered`
              : `${processed}/${total || "?"} files`}
          </span>
          {!discovering && <span>{percent.toFixed(1)}%</span>}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {!discovering && folderProgress.remaining != null && (
            <span>{folderProgress.remaining} remaining</span>
          )}
          {folderProgress.filesPerSecond != null && (
            <span>{Number(folderProgress.filesPerSecond).toFixed(2)}/sec</span>
          )}
          {!discovering && eta && <span>ETA {eta}</span>}
          {folderProgress.unsupported > 0 && (
            <span>{folderProgress.unsupported} unsupported</span>
          )}
        </div>
        {folderProgress.relativePath && (
          <div
            className="truncate text-[11px] text-muted-foreground"
            title={String(folderProgress.relativePath)}
          >
            Folder: {String(folderProgress.relativePath)}
          </div>
        )}
      </div>
    );
  }

  // --- Enrollment ---
  if (job.type === "enrollment") {
    if (isCompleted) {
      return (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {result.profile_name && <span>{result.profile_name}</span>}
            {result.sample_count != null && (
              <span>{result.sample_count} samples</span>
            )}
            {result.total_duration != null && (
              <span>{result.total_duration.toFixed(1)}s</span>
            )}
            {result.is_primary && (
              <Badge
                variant="secondary"
                className="bg-green-500/10 text-green-500 text-xs"
              >
                primary
              </Badge>
            )}
          </div>
        </div>
      );
    }
    if (isActive && progress.stage) {
      const stageLabels: Record<string, string> = {
        loading_audio: "Loading audio",
        extracting_embedding: "Extracting",
        saving_profile: "Saving",
      };
      return (
        <div className="space-y-1">
          <Badge
            variant="secondary"
            className="bg-blue-500/10 text-blue-500 text-xs"
          >
            {stageLabels[progress.stage] ?? progress.stage}
          </Badge>
          {progress.message && (
            <div className="text-xs text-muted-foreground">
              {progress.message}
            </div>
          )}
        </div>
      );
    }
  }

  // --- Runs that touched nothing, for types without a dedicated cell above ---
  if (isEmptyJobResult(job)) {
    return (
      <Badge
        variant="secondary"
        className="bg-amber-500/10 text-amber-500 text-xs"
      >
        Empty
      </Badge>
    );
  }

  // --- Generic fallback for any job with progress ---
  if (job.progress && typeof job.progress === "object") {
    const percentage = (() => {
      const p = job.progress;
      if (typeof p.progress === "number") return p.progress;
      if (
        typeof p.processed === "number" && typeof p.total === "number" &&
        p.total > 0
      ) {
        return (p.processed / p.total) * 100;
      }
      if (
        typeof p.iteration === "number" && typeof p.total === "number" &&
        p.total > 0
      ) {
        return (p.iteration / p.total) * 100;
      }
      return null;
    })();
    return (
      <div className="space-y-2">
        {percentage !== null && <Progress value={percentage} className="h-2" />}
        <div className="text-xs space-y-1">
          {Object.entries(job.progress)
            .filter(([, v]) => typeof v !== "object" || v === null)
            .slice(0, 3).map(([k, v]) => (
              <div key={k}>
                <span className="opacity-70">{k}:</span> {String(v)}
              </div>
            ))}
        </div>
      </div>
    );
  }

  return <span className="text-muted-foreground">-</span>;
}
