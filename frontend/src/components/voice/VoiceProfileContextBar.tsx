import { Link } from "react-router-dom";
import { AlertCircle, Plus, UserRound } from "lucide-react";
import { normalizeObjectId } from "@/lib/diarization";
import { withVoiceProfile } from "@/lib/voiceProfileNavigation";
import type { SelectedVoiceProfile } from "@/hooks/useSelectedVoiceProfile";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function VoiceProfileSelect({
  selection,
  ariaLabel = "Voice profile",
  className = "h-9 rounded-md border bg-background px-2 text-sm",
}: {
  selection: SelectedVoiceProfile;
  ariaLabel?: string;
  className?: string;
}) {
  const selectableProfiles = selection.profiles.filter((profile) =>
    !profile.archivedAt && profile.lifecycleStatus !== "archived" &&
    profile.status !== "archived"
  );
  return (
    <select
      aria-label={ariaLabel}
      className={className}
      value={selection.selectedProfileId ?? ""}
      disabled={selection.isLoading || selectableProfiles.length === 0}
      onChange={(event) => selection.selectProfile(event.target.value)}
    >
      {!selection.selectedProfileId && (
        <option value="" disabled>
          {selection.invalidRequestedProfileId
            ? "Choose another voice"
            : "No voice profiles"}
        </option>
      )}
      {selectableProfiles.map((profile) => {
        const id = normalizeObjectId(profile._id);
        if (!id) return null;
        return (
          <option key={id} value={id}>
            {profile.name}
            {profile.is_primary ? " · primary" : ""}
          </option>
        );
      })}
    </select>
  );
}

export function VoiceProfileContextBar({
  selection,
  compact = false,
}: {
  selection: SelectedVoiceProfile;
  compact?: boolean;
}) {
  const selected = selection.selectedProfile;
  return (
    <div
      className={compact
        ? "space-y-2 rounded-md border bg-background/95 p-3"
        : "sticky top-0 z-20 flex flex-wrap items-center gap-3 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur"}
      data-testid="voice-profile-context"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white"
          style={{ backgroundColor: selected?.color ?? "#64748b" }}
        >
          <UserRound className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">Working with voice</p>
          <VoiceProfileSelect selection={selection} />
        </div>
      </div>
      {selected && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">Revision {selected.revision ?? 1}</Badge>
          {selected.is_primary && <Badge variant="secondary">My voice</Badge>}
          {selected.embeddingSpaceId
            ? (
              <Badge className="bg-green-500/10 text-green-700">
                Voiceprint ready
              </Badge>
            )
            : (
              <Badge className="bg-amber-500/10 text-amber-700">
                Needs build
              </Badge>
            )}
        </div>
      )}
      {selection.invalidRequestedProfileId && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <AlertCircle className="h-4 w-4" />
          Profile {selection.invalidRequestedProfileId}{" "}
          is unavailable or archived. Choose another voice; the page did not
          switch silently.
        </div>
      )}
      <div
        className={compact
          ? "flex flex-wrap gap-2"
          : "ml-auto flex flex-wrap gap-2"}
      >
        <Button asChild size="sm" variant="outline">
          <Link
            to={withVoiceProfile(
              "/settings/voice-profiles",
              selection.selectedProfileId,
            )}
          >
            Manage samples
          </Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/settings/voice-profiles?create=1">
            <Plus className="mr-1 h-4 w-4" />New voice
          </Link>
        </Button>
      </div>
    </div>
  );
}
