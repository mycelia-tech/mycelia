import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Clock3,
  FileAudio,
  Loader2,
  Plus,
  RotateCcw,
  SkipForward,
} from "lucide-react";
import {
  WaveformPlayer,
  type WaveformPlayerHandle,
} from "@/components/audio/WaveformPlayer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddTimelineVoiceSampleDialog } from "@/components/voice/AddTimelineVoiceSampleDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { normalizeObjectId } from "@/lib/diarization";
import { useAudioPlaybackStore } from "@/stores/audioPlaybackStore";

export type VoiceIdentityDecision =
  | "me"
  | "me-timeline-only"
  | "not-me"
  | "skip";
type ReviewCommand =
  | VoiceIdentityDecision
  | "play"
  | "previous"
  | "next"
  | "undo"
  | "edit"
  | { type: "profile"; index: number };

export type VoiceIdentityProfileOption = {
  id: string;
  name: string;
};

export interface VoiceIdentityReviewSegment {
  _id: unknown;
  original_id?: unknown;
  original?: unknown;
  runId?: string;
  embeddingSpaceId?: string;
  speaker?: string;
  start: Date | string;
  end: Date | string;
  speakerIdentity?: {
    primaryScore?: number;
    state?: string;
    profileId?: unknown;
    topCandidate?: VoiceIdentityCandidate;
    candidates?: VoiceIdentityCandidate[];
  };
}

type VoiceIdentityCandidate = {
  profileId?: unknown;
  name?: string | null;
  score?: number;
};

interface VoiceIdentityReviewPlayerProps {
  segment: VoiceIdentityReviewSegment;
  profileName?: string;
  profileOptions: VoiceIdentityProfileOption[];
  position: number;
  remaining: number;
  sessionAnswered: number;
  sessionTotal: number;
  pending: boolean;
  autoPlayNext: boolean;
  playOnMount: boolean;
  canPrevious: boolean;
  canNext: boolean;
  canUndo: boolean;
  canEdit: boolean;
  editingLabel?: string | null;
  alternateProfiles: VoiceIdentityProfileOption[];
  creatingProfile: boolean;
  shortcutsEnabled?: boolean;
  onDecision: (decision: VoiceIdentityDecision) => void;
  onAssignProfile: (profileId: string) => void;
  onCreateProfile: (name: string) => Promise<void>;
  onPrevious: () => void;
  onNext: () => void;
  onUndo: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onAutoPlayChange: (enabled: boolean) => void;
}

const SWIPE_DISTANCE_PX = 72;
const SWIPE_MAX_VERTICAL_PX = 48;

export function getReviewShortcut(key: string): ReviewCommand | null {
  if (/^[1-3]$/.test(key)) {
    return { type: "profile", index: Number(key) - 1 };
  }
  switch (key) {
    case " ":
    case "Spacebar":
      return "play";
    case "ArrowLeft":
      return "not-me";
    case "ArrowRight":
      return "me";
    case "ArrowUp":
      return "previous";
    case "ArrowDown":
      return "next";
    case "u":
    case "U":
      return "undo";
    case "s":
    case "S":
      return "skip";
    case "t":
    case "T":
      return "me-timeline-only";
    case "e":
    case "E":
      return "edit";
    default:
      return null;
  }
}

export function getSwipeDecision(
  start: { x: number; y: number },
  end: { x: number; y: number },
): VoiceIdentityDecision | null {
  const horizontal = end.x - start.x;
  const vertical = Math.abs(end.y - start.y);
  if (
    Math.abs(horizontal) < SWIPE_DISTANCE_PX ||
    vertical > SWIPE_MAX_VERTICAL_PX
  ) return null;
  return horizontal > 0 ? "me" : "not-me";
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(
    target.closest(
      "input, textarea, select, button, a, [contenteditable='true'], [role='switch']",
    ),
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(
    target.closest("input, textarea, select, [contenteditable='true']"),
  );
}

function durationSeconds(segment: VoiceIdentityReviewSegment): number {
  const start = new Date(segment.start).getTime();
  const end = new Date(segment.end).getTime();
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, (end - start) / 1000)
    : 0;
}

export function buildVoiceReviewAudioUrl(
  segment: VoiceIdentityReviewSegment,
): string | null {
  const originalId = normalizeObjectId(segment.original_id ?? segment.original);
  const start = new Date(segment.start).getTime() / 1000;
  const end = new Date(segment.end).getTime() / 1000;
  if (!originalId || !Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  return `/api/audio/wav?start=${encodeURIComponent(String(start))}&end=${
    encodeURIComponent(String(end))
  }&original_id=${encodeURIComponent(originalId)}`;
}

export function VoiceIdentityReviewPlayer({
  segment,
  profileName = "target profile",
  profileOptions,
  position,
  remaining,
  sessionAnswered,
  sessionTotal,
  pending,
  autoPlayNext,
  playOnMount,
  canPrevious,
  canNext,
  canUndo,
  canEdit,
  editingLabel,
  alternateProfiles,
  creatingProfile,
  shortcutsEnabled = true,
  onDecision,
  onAssignProfile,
  onCreateProfile,
  onPrevious,
  onNext,
  onUndo,
  onEdit,
  onCancelEdit,
  onAutoPlayChange,
}: VoiceIdentityReviewPlayerProps) {
  const playerRef = useRef<WaveformPlayerHandle>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState(
    alternateProfiles[0]?.id ?? "",
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const id = normalizeObjectId(segment._id);
  const originalId = normalizeObjectId(segment.original_id ?? segment.original);
  const duration = durationSeconds(segment);
  const audioUrl = buildVoiceReviewAudioUrl(segment);
  const score = segment.speakerIdentity?.primaryScore;
  const hasScore = typeof score === "number" && Number.isFinite(score);
  const candidateProfiles = useMemo(() => {
    const source = segment.speakerIdentity?.candidates?.length
      ? segment.speakerIdentity.candidates
      : segment.speakerIdentity?.topCandidate
      ? [segment.speakerIdentity.topCandidate]
      : [];
    return source.flatMap((candidate) => {
      const candidateId = normalizeObjectId(candidate.profileId);
      const candidateScore = candidate.score;
      if (
        !candidateId || typeof candidateScore !== "number" ||
        !Number.isFinite(candidateScore)
      ) return [];
      const knownName = profileOptions.find((profile) =>
        profile.id === candidateId
      )?.name;
      return [{
        id: candidateId,
        name: candidate.name || knownName || candidateId,
        score: candidateScore,
      }];
    }).sort((a, b) => b.score - a.score).slice(0, 3);
  }, [profileOptions, segment.speakerIdentity]);
  const sessionPercent = sessionTotal > 0
    ? Math.min(100, Math.round((sessionAnswered / sessionTotal) * 100))
    : 0;
  const stopThen = (action: () => void) => {
    useAudioPlaybackStore.getState().stopActive();
    action();
  };

  useEffect(() => {
    if (
      !alternateProfiles.some((profile) => profile.id === selectedProfileId)
    ) {
      setSelectedProfileId(alternateProfiles[0]?.id ?? "");
    }
  }, [alternateProfiles, selectedProfileId]);

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const command = getReviewShortcut(event.key);
      if (!command) return;
      if (typeof command === "object") {
        if (
          pending || isTypingTarget(event.target) ||
          isTypingTarget(document.activeElement)
        ) return;
        const profile = alternateProfiles[command.index];
        if (profile) {
          event.preventDefault();
          stopThen(() => onAssignProfile(profile.id));
        }
        return;
      }
      if (
        isInteractiveTarget(event.target) ||
        isInteractiveTarget(document.activeElement)
      ) return;
      if (command === "play") {
        event.preventDefault();
        playerRef.current?.togglePlayback();
        return;
      }
      if (command === "edit" && canEdit) {
        event.preventDefault();
        stopThen(onEdit);
        return;
      }
      if (pending) return;
      if (
        command === "me" || command === "me-timeline-only" ||
        command === "not-me" || command === "skip"
      ) {
        event.preventDefault();
        stopThen(() => onDecision(command));
      } else if (command === "previous" && canPrevious) {
        event.preventDefault();
        stopThen(onPrevious);
      } else if (command === "next" && canNext) {
        event.preventDefault();
        stopThen(onNext);
      } else if (command === "undo" && canUndo) {
        event.preventDefault();
        stopThen(onUndo);
      }
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [
    canNext,
    canPrevious,
    canUndo,
    canEdit,
    alternateProfiles,
    onDecision,
    onAssignProfile,
    onEdit,
    onNext,
    onPrevious,
    onUndo,
    pending,
    shortcutsEnabled,
  ]);

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || pending || isInteractiveTarget(event.target)) return;
    const decision = getSwipeDecision(start, {
      x: event.clientX,
      y: event.clientY,
    });
    if (decision) stopThen(() => onDecision(decision));
  };

  return (
    <div
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
      data-testid="voice-review-card"
      onPointerDown={(event) => {
        pointerStartRef.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={handlePointerUp}
    >
      <div className="border-b bg-gradient-to-r from-sky-500/10 via-background to-violet-500/10 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Segment {position} · {remaining} remaining
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {id
                ? (
                  <Link
                    className="font-medium text-primary hover:underline"
                    to={`/diarizations/${id}`}
                  >
                    {new Date(segment.start).toLocaleString()}
                  </Link>
                )
                : <span>{new Date(segment.start).toLocaleString()}</span>}
              <Badge variant="outline" className="gap-1 font-normal">
                <Clock3 className="h-3 w-3" />
                {duration.toFixed(1)} sec
              </Badge>
            </div>
          </div>
          <div className="text-right">
            {hasScore
              ? (
                <Badge className="text-sm">
                  Similarity to {profileName}: {Math.round(score * 100)}%
                </Badge>
              )
              : <Badge variant="secondary">Not classified</Badge>}
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              {hasScore
                ? "Matcher similarity, not a calibrated probability."
                : "No identity matcher result exists for this segment yet."}
            </p>
            {candidateProfiles.length > 0 && (
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                Model candidates: {candidateProfiles.map((candidate) =>
                  `${candidate.name} ${Math.round(candidate.score * 100)}%`
                ).join(" · ")}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-5 p-4 sm:p-6 @4xl/settings:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="space-y-5">
          {editingLabel && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2 text-sm">
              <span>
                Editing previous answer:{" "}
                <strong>{editingLabel}</strong>. Choose the corrected speaker
                label or mark it Noise / unclear.
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => stopThen(onCancelEdit)}
              >
                Cancel edit
              </Button>
            </div>
          )}
          {audioUrl
            ? (
              <div className="rounded-lg border bg-muted/20 p-3">
                <WaveformPlayer
                  ref={playerRef}
                  key={id ?? audioUrl}
                  audioUrl={audioUrl}
                  duration={duration}
                  autoPlay={playOnMount}
                  ariaLabel="Play voice review segment"
                />
              </div>
            )
            : (
              <div className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
                This segment has no valid source audio reference.
              </div>
            )}

          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              size="lg"
              variant="outline"
              className="h-14 justify-start border-rose-500/40 text-base hover:bg-rose-500/10"
              disabled={pending}
              onClick={() => stopThen(() => onDecision("not-me"))}
            >
              <ArrowLeft className="mr-2 h-5 w-5" />
              <span className="text-left">
                <span className="block">Not {profileName}</span>
                <span className="block text-xs font-normal opacity-70">
                  clear other voice · calibration
                </span>
              </span>
            </Button>
            <Button
              size="lg"
              className="h-14 justify-start bg-sky-600 text-base hover:bg-sky-700"
              disabled={pending}
              onClick={() => stopThen(() => onDecision("me"))}
            >
              <span className="text-left">
                <span className="block">{profileName} · clear</span>
                <span className="block text-xs font-normal opacity-80">
                  Timeline + calibration
                </span>
              </span>
              <ArrowRight className="ml-auto h-5 w-5" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-14 justify-start border-sky-500/40"
              disabled={pending}
              onClick={() => stopThen(() => onDecision("me-timeline-only"))}
              title="Label the speaker on Timeline but exclude this ambiguous clip from calibration (T)"
            >
              <span className="text-left">
                <span className="block">{profileName} · Timeline only</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  overlap / mumble · not calibration
                </span>
              </span>
            </Button>
            <Button
              size="lg"
              variant="ghost"
              className="h-14 justify-start text-muted-foreground"
              disabled={pending}
              onClick={() => stopThen(() => onDecision("skip"))}
              title="Keep this segment unlabeled and exclude it from calibration (S)"
            >
              <SkipForward className="mr-2 h-4 w-4" />
              <span className="text-left">
                <span className="block">Noise / unclear</span>
                <span className="block text-xs font-normal opacity-70">
                  no reliable speaker label
                </span>
              </span>
            </Button>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Use clear only for one recognizable speaker. Timeline-only keeps a
            useful identity label without training calibration on overlap,
            mumbling, or a doubtful fragment.
          </p>

          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              Assigning labels this interval immediately. A saved 10–30 second
              voice sample is separate and is used later to rebuild the profile
              embedding.
            </p>
            {alternateProfiles.length > 0 && (
              <div
                className="mb-3 grid gap-2 sm:grid-cols-3"
                aria-label="Recently used speakers"
              >
                {alternateProfiles.slice(0, 3).map((profile, index) => (
                  <Button
                    key={profile.id}
                    type="button"
                    variant="secondary"
                    className="min-w-0 justify-start"
                    disabled={pending}
                    onClick={() => stopThen(() => onAssignProfile(profile.id))}
                    title={`Assign ${profile.name} · shortcut ${index + 1}`}
                  >
                    <kbd className="mr-2 rounded border bg-background px-1.5 py-0.5 text-xs">
                      {index + 1}
                    </kbd>
                    <span className="truncate">{profile.name}</span>
                  </Button>
                ))}
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              {alternateProfiles.length > 0
                ? (
                  <>
                    <label
                      className="sr-only"
                      htmlFor="voice-review-other-profile"
                    >
                      Assign another profile
                    </label>
                    <select
                      id="voice-review-other-profile"
                      className="h-10 rounded-md border bg-background px-3 text-sm"
                      value={selectedProfileId}
                      onChange={(event) =>
                        setSelectedProfileId(event.target.value)}
                    >
                      {alternateProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="outline"
                      disabled={pending || !selectedProfileId}
                      onClick={() =>
                        stopThen(() => onAssignProfile(selectedProfileId))}
                    >
                      Assign profile
                    </Button>
                  </>
                )
                : (
                  <span className="self-center text-sm">
                    No other profiles yet
                  </span>
                )}
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  useAudioPlaybackStore.getState().stopActive();
                  setCreateOpen(true);
                }}
              >
                <Plus className="mr-1 h-4 w-4" />New speaker
              </Button>
            </div>
            <Button
              className="mt-2 px-0 text-xs"
              size="sm"
              variant="link"
              disabled={!originalId || duration < 3 || duration > 120}
              title={duration < 3
                ? "Voice samples require at least 3 seconds; use a safe grouped clip or Timeline selection"
                : "Save this clear, single-speaker clip for profile enrollment"}
              onClick={() => {
                useAudioPlaybackStore.getState().stopActive();
                setSampleOpen(true);
              }}
            >
              <FileAudio className="mr-1 h-4 w-4" />
              Save current clip as voice sample
            </Button>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Swipe or use ← Not {profileName} · → {profileName} clear{" "}
            · T Timeline-only · S noise/unclear · 1–3 recent speakers · Space
            plays · U undoes · E edits
          </p>
        </div>

        <aside className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <div>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Current window</span>
              <span>{sessionAnswered} / {sessionTotal}</span>
            </div>
            <Progress className="mt-2" value={sessionPercent} />
          </div>

          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              <span className="block font-medium">Automatically play next</span>
              <span className="block text-xs text-muted-foreground">
                After a saved answer
              </span>
            </span>
            <Switch
              checked={autoPlayNext}
              onCheckedChange={onAutoPlayChange}
              aria-label="Automatically play next"
            />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!canPrevious || pending}
              onClick={() => stopThen(onPrevious)}
              aria-label="Previous segment"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canUndo || pending}
              onClick={() => stopThen(onUndo)}
            >
              <RotateCcw className="mr-1 h-4 w-4" />Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!canNext || pending}
              onClick={() => stopThen(onNext)}
              aria-label="Next segment"
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>
        </aside>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create and assign a speaker</DialogTitle>
            <DialogDescription>
              The selected review segment or safe group seeds the new profile
              and is labeled immediately. This creates no saved voice sample;
              add a clean Timeline clip later for durable re-enrollment.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="review-new-speaker-name">Speaker name</Label>
            <Input
              id="review-new-speaker-name"
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
              placeholder="e.g. Andrew Kislov"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={pending || creatingProfile}
            >
              Cancel
            </Button>
            <Button
              disabled={!newProfileName.trim() || pending || creatingProfile}
              onClick={async () => {
                try {
                  await onCreateProfile(newProfileName.trim());
                  setNewProfileName("");
                  setCreateOpen(false);
                } catch {
                  // Parent mutations show the actionable error and keep the
                  // dialog open so the name can be corrected or retried.
                }
              }}
            >
              {(pending || creatingProfile) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Create and assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {sampleOpen && (
        <AddTimelineVoiceSampleDialog
          open
          onOpenChange={setSampleOpen}
          startDate={new Date(segment.start)}
          endDate={new Date(segment.end)}
          originalId={originalId ?? undefined}
          source="review_selection"
        />
      )}
    </div>
  );
}
