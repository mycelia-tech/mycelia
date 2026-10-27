import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { BROWSER_TIME_ZONE, type DefaultTimeZone } from "@/lib/timeZones";

type Theme = "light" | "dark" | "system";
export type TimelineTimeZoneMode = "contextual" | "browser" | "fixed";

type TimeFormat =
  | "gregorian-local-natural"
  | "gregorian-local-iso"
  | "gregorian-local-verbose"
  | "gregorian-local-european"
  | "gregorian-local-american"
  | "gregorian-utc-iso"
  | "gregorian-utc-verbose"
  | "gregorian-utc-european"
  | "gregorian-utc-american"
  | "si-int"
  | "si-formatted";

interface SettingsState {
  apiEndpoint: string;
  clientId: string;
  clientSecret: string;
  sessionStatus: "unknown" | "authenticated" | "anonymous";
  sessionRevision: number;
  setSessionStatus: (status: "unknown" | "authenticated" | "anonymous") => void;
  theme: Theme;
  timeFormat: TimeFormat;
  defaultTimeZone: DefaultTimeZone;
  timelineTimeZoneMode: TimelineTimeZoneMode;
  timelineTimeZoneOverride: string;
  favoriteTimeZones: string[];
  transcriptThresholdHours: number;
  preferredAudioDeviceId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  playbackRate: number;
  volume: number;
  autoSave: boolean;
  mapTileUrl: string;
  setApiEndpoint: (endpoint: string) => void;
  setClientId: (id: string) => void;
  setClientSecret: (secret: string) => void;
  setTheme: (theme: Theme) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setDefaultTimeZone: (timeZone: DefaultTimeZone) => void;
  setTimelineTimeZoneMode: (mode: TimelineTimeZoneMode) => void;
  setTimelineTimeZoneOverride: (timeZone: string) => void;
  toggleFavoriteTimeZone: (timeZone: string) => void;
  setTranscriptThresholdHours: (hours: number) => void;
  setPreferredAudioDeviceId: (deviceId: string | null) => void;
  setEchoCancellation: (enabled: boolean) => void;
  setNoiseSuppression: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setAutoSave: (enabled: boolean) => void;
  setMapTileUrl: (url: string) => void;
  clearSettings: () => void;
}

export const DEFAULT_MAP_TILE_URL =
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

function getDefaultApiEndpoint(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

const DEFAULT_API_ENDPOINT = getDefaultApiEndpoint();
const DEFAULT_TIME_FORMAT: TimeFormat = "gregorian-local-natural";
const DEFAULT_TRANSCRIPT_THRESHOLD_HOURS = 12;
const DEFAULT_PLAYBACK_RATE = 1;
const DEFAULT_VOLUME = 1;

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiEndpoint: DEFAULT_API_ENDPOINT,
      clientId: "",
      clientSecret: "",
      sessionStatus: "unknown",
      sessionRevision: 0,
      setSessionStatus: (sessionStatus) => set((state) => ({ sessionStatus, sessionRevision: state.sessionRevision + 1 })),
      theme: "system",
      timeFormat: DEFAULT_TIME_FORMAT,
      defaultTimeZone: BROWSER_TIME_ZONE,
      timelineTimeZoneMode: "contextual",
      timelineTimeZoneOverride: "UTC",
      favoriteTimeZones: [],
      transcriptThresholdHours: DEFAULT_TRANSCRIPT_THRESHOLD_HOURS,
      mapTileUrl: DEFAULT_MAP_TILE_URL,
      preferredAudioDeviceId: null,
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      playbackRate: DEFAULT_PLAYBACK_RATE,
      volume: DEFAULT_VOLUME,
      autoSave: true,
      setApiEndpoint: (endpoint) => set((state) => ({ apiEndpoint: endpoint,
        ...(state.apiEndpoint !== endpoint && { sessionStatus: "unknown" as const, sessionRevision: state.sessionRevision + 1, clientSecret: "" }) })),
      setClientId: (id) => set({ clientId: id }),
      setClientSecret: (secret) => set({ clientSecret: secret }),
      setTheme: (theme) => set({ theme }),
      setTimeFormat: (format) => set({ timeFormat: format }),
      setDefaultTimeZone: (timeZone) => set({ defaultTimeZone: timeZone }),
      setTimelineTimeZoneMode: (mode) => set({ timelineTimeZoneMode: mode }),
      setTimelineTimeZoneOverride: (timeZone) =>
        set({ timelineTimeZoneOverride: timeZone }),
      toggleFavoriteTimeZone: (timeZone) =>
        set((state) => ({
          favoriteTimeZones: state.favoriteTimeZones.includes(timeZone)
            ? state.favoriteTimeZones.filter((item) => item !== timeZone)
            : [...state.favoriteTimeZones, timeZone],
        })),
      setTranscriptThresholdHours: (hours) =>
        set({ transcriptThresholdHours: hours }),
      setPreferredAudioDeviceId: (deviceId) =>
        set({ preferredAudioDeviceId: deviceId }),
      setEchoCancellation: (enabled) => set({ echoCancellation: enabled }),
      setNoiseSuppression: (enabled) => set({ noiseSuppression: enabled }),
      setAutoGainControl: (enabled) => set({ autoGainControl: enabled }),
      setPlaybackRate: (rate) => set({ playbackRate: rate }),
      setVolume: (volume) => set({ volume }),
      setAutoSave: (enabled) => set({ autoSave: enabled }),
      setMapTileUrl: (url) =>
        set({ mapTileUrl: url.trim() || DEFAULT_MAP_TILE_URL }),
      clearSettings: () =>
        set({
          apiEndpoint: DEFAULT_API_ENDPOINT,
          clientId: "",
          clientSecret: "",
          sessionStatus: "anonymous",
          theme: "system",
          timeFormat: DEFAULT_TIME_FORMAT,
          defaultTimeZone: BROWSER_TIME_ZONE,
          timelineTimeZoneMode: "contextual",
          timelineTimeZoneOverride: "UTC",
          favoriteTimeZones: [],
          transcriptThresholdHours: DEFAULT_TRANSCRIPT_THRESHOLD_HOURS,
          mapTileUrl: DEFAULT_MAP_TILE_URL,
          preferredAudioDeviceId: null,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          playbackRate: DEFAULT_PLAYBACK_RATE,
          volume: DEFAULT_VOLUME,
          autoSave: true,
        }),
    }),
    {
      name: "mycelia-settings",
      storage: createJSONStorage(() => window.localStorage),
      version: 1,
      // Discard the permanent key from older installations. The owner signs
      // in once to replace it with a protected server-side browser session.
      migrate: (persisted: any) => {
        const { clientSecret: _secret, sessionStatus: _status, sessionRevision: _revision, ...settings } = persisted ?? {};
        return settings;
      },
      partialize: ({ clientSecret: _secret, sessionStatus: _status, sessionRevision: _revision, ...settings }) => settings,
    },
  ),
);

export type { TimeFormat };
