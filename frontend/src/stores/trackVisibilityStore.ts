import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ObjectCategory,
  ObjectsLayoutMode,
  TrackId,
} from "@/types/tracks";

const DEFAULT_VISIBLE_TRACKS: TrackId[] = [
  "voice-detection",
  "data-presence",
  "transcriptions",
  "audio-chunks",
  "diarization-coverage",
  "diarizations",
  "objects",
  "photos",
];

// "locations" is deliberately NOT in DEFAULT_VISIBLE_TRACKS: the track is
// opt-in and performs zero requests until enabled in the visibility panel.
const DEFAULT_HEIGHTS: Record<TrackId, number> = {
  "voice-detection": 32,
  "data-presence": 20,
  "transcriptions": 40,
  "audio-chunks": 40,
  "diarization-coverage": 32,
  "diarizations": 40,
  "objects": 120,
  "locations": 28,
  "photos": 48,
};

const ALL_OBJECT_CATEGORIES: ObjectCategory[] = [
  "event",
  "person",
  "relationship",
  "promise",
  "other",
];

interface TrackVisibilityState {
  visibleTracks: TrackId[];
  trackHeights: Record<string, number>;
  objectsLayoutMode: ObjectsLayoutMode;
  visibleObjectCategories: ObjectCategory[];
  toggleTrack: (id: TrackId) => void;
  setTrackVisible: (id: TrackId, visible: boolean) => void;
  setTrackHeight: (id: TrackId, height: number) => void;
  showAll: () => void;
  hideAll: () => void;
  resetDefaults: () => void;
  isVisible: (id: TrackId) => boolean;
  setObjectsLayoutMode: (mode: ObjectsLayoutMode) => void;
  toggleObjectCategory: (category: ObjectCategory) => void;
}

export const useTrackVisibilityStore = create<TrackVisibilityState>()(
  persist(
    (set, get) => ({
      visibleTracks: [...DEFAULT_VISIBLE_TRACKS],
      trackHeights: { ...DEFAULT_HEIGHTS },
      objectsLayoutMode: "by-category" as ObjectsLayoutMode,
      visibleObjectCategories: [...ALL_OBJECT_CATEGORIES],

      toggleTrack: (id) => {
        set((state) => {
          const isCurrentlyVisible = state.visibleTracks.includes(id);
          if (isCurrentlyVisible) {
            return {
              visibleTracks: state.visibleTracks.filter((t) => t !== id),
            };
          } else {
            return {
              visibleTracks: [...state.visibleTracks, id],
            };
          }
        });
      },

      setTrackVisible: (id, visible) => {
        set((state) => {
          const isCurrentlyVisible = state.visibleTracks.includes(id);
          if (isCurrentlyVisible === visible) return state;
          return {
            visibleTracks: visible
              ? [...state.visibleTracks, id]
              : state.visibleTracks.filter((trackId) => trackId !== id),
          };
        });
      },

      setTrackHeight: (id, height) => {
        set((state) => ({
          trackHeights: { ...state.trackHeights, [id]: height },
        }));
      },

      showAll: () => set({ visibleTracks: [...DEFAULT_VISIBLE_TRACKS] }),
      hideAll: () => set({ visibleTracks: [] }),
      resetDefaults: () =>
        set({
          visibleTracks: [...DEFAULT_VISIBLE_TRACKS],
          trackHeights: { ...DEFAULT_HEIGHTS },
          objectsLayoutMode: "by-category",
          visibleObjectCategories: [...ALL_OBJECT_CATEGORIES],
        }),

      isVisible: (id) => get().visibleTracks.includes(id),

      setObjectsLayoutMode: (mode) => set({ objectsLayoutMode: mode }),

      toggleObjectCategory: (category: ObjectCategory) => {
        set((state) => {
          const isVisible = state.visibleObjectCategories.includes(category);
          if (isVisible) {
            return {
              visibleObjectCategories: state.visibleObjectCategories.filter(
                (c: ObjectCategory) => c !== category,
              ),
            };
          } else {
            return {
              visibleObjectCategories: [
                ...state.visibleObjectCategories,
                category,
              ],
            };
          }
        });
      },
    }),
    {
      name: "track-visibility",
      version: 2,
      migrate: (persisted: any, version) => {
        if (version >= 2) return persisted;
        const visibleTracks = Array.isArray(persisted?.visibleTracks)
          ? persisted.visibleTracks
          : [];
        return {
          ...persisted,
          visibleTracks: [...new Set([...visibleTracks, "photos"])],
          trackHeights: { photos: 48, ...(persisted?.trackHeights ?? {}) },
        };
      },
    },
  ),
);
