import type * as d3 from "d3";
import type { HistogramItem } from "@/modules/histogram/useHistogramCache";

export type TrackId =
  | "voice-detection"
  | "data-presence"
  | "transcriptions"
  | "audio-chunks"
  | "diarizations"
  | "diarization-coverage"
  | "objects"
  | "locations"
  | "photos";

// Object categories for timeline grouping
export type ObjectCategory =
  | "person"
  | "event"
  | "relationship"
  | "promise"
  | "place"
  | "organization"
  | "product"
  | "project"
  | "animal"
  | "concept"
  | "media"
  | "other";

export type ObjectsLayoutMode = "mixed" | "by-category";

export interface ObjectCategoryConfig {
  id: ObjectCategory;
  label: string;
  color: string;
  icon: string;
}

export const OBJECT_CATEGORIES: ObjectCategoryConfig[] = [
  { id: "event", label: "Events", color: "#8b5cf6", icon: "📅" },
  { id: "person", label: "People", color: "#3b82f6", icon: "👤" },
  { id: "relationship", label: "Relationships", color: "#ec4899", icon: "🔗" },
  { id: "promise", label: "Promises", color: "#f97316", icon: "🤝" },
  { id: "place", label: "Places", color: "#14b8a6", icon: "📍" },
  { id: "organization", label: "Organizations", color: "#6366f1", icon: "🏢" },
  { id: "product", label: "Products", color: "#f59e0b", icon: "📱" },
  { id: "project", label: "Projects", color: "#a855f7", icon: "📁" },
  { id: "animal", label: "Animals", color: "#84cc16", icon: "🐾" },
  { id: "concept", label: "Concepts", color: "#0ea5e9", icon: "💡" },
  { id: "media", label: "Media", color: "#d946ef", icon: "🎬" },
  { id: "other", label: "Other", color: "#6b7280", icon: "📦" },
];

export interface TrackConfig {
  id: TrackId;
  label: string;
  description?: string;
  defaultVisible: boolean;
  defaultHeight: number;
  color: string;
}

export interface TrackRenderProps {
  scale: d3.ScaleTime<number, number>;
  transform: d3.ZoomTransform;
  width: number;
  height: number;
  items: HistogramItem[];
}

export interface Track {
  config: TrackConfig;
  component: React.ComponentType<TrackRenderProps>;
}

export interface TrackVisibilityState {
  visibleTracks: Set<TrackId>;
  trackHeights: Record<TrackId, number>;
  toggleTrack: (id: TrackId) => void;
  setTrackVisible: (id: TrackId, visible: boolean) => void;
  setTrackHeight: (id: TrackId, height: number) => void;
  showAll: () => void;
  hideAll: () => void;
  resetDefaults: () => void;
}
