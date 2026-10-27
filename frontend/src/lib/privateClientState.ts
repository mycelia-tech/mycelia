import { queryClient } from "@/lib/queryClient";
import { useHistogramCache } from "@/modules/histogram/useHistogramCache";
import { useAudioPlayer } from "@/modules/audio/player";
import { resetTranscriptCache } from "@/modules/audio/useTranscripts";
import { useAudioPlaybackStore } from "@/stores/audioPlaybackStore";
import { useMessengerStore } from "@/stores/messengerStore";
import { useTopicsStore } from "@/stores/topicsStore";
import { useNotificationStore } from "@/stores/notificationStore";
import { useObjectSelectionStore } from "@/stores/objectSelectionStore";
import { useSpanningObjectsStore } from "@/stores/spanningObjectsStore";
import { useLocationSelectionStore } from "@/stores/locationSelectionStore";

/** Invalidate private data before another account or endpoint can render it. */
export function resetPrivateClientState() {
  queryClient.clear();
  useHistogramCache.getState().invalidateAll();
  resetTranscriptCache();
  useAudioPlaybackStore.getState().stopActive();
  useAudioPlayer.getState().setIsPlaying(false);
  useAudioPlayer.getState().resetDate(null);
  useMessengerStore.getState().reset();
  useTopicsStore.getState().reset();
  useNotificationStore.getState().clearAll();
  useObjectSelectionStore.getState().clearSelection();
  useSpanningObjectsStore.getState().clear();
  useLocationSelectionStore.getState().clear();
}
