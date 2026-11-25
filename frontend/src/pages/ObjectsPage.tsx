import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { callResource } from "@/lib/api";
import type { Object as ObjectModel } from "@/types/objects";
import { useDuplicateGroups } from "@/hooks/useObjectQueries";
import { MergeObjectDialog } from "@/components/dialogs/MergeObjectDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeftRight,
  ArrowRight,
  Box,
  Building2,
  Calendar,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Combine,
  Film,
  FolderKanban,
  Handshake,
  Lightbulb,
  Link2,
  Link2Off,
  MapPin,
  MessageSquare,
  Package,
  PawPrint,
  Plus,
  RefreshCw,
  Search,
  SortAsc,
  SortDesc,
  Star,
  Tag,
  User,
  Users,
  X,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

function escapeRegex(source: string) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Object icons are { text } | { base64 }; only text icons render as chips.
function iconText(icon: ObjectModel["icon"]): string {
  return icon && "text" in icon && icon.text ? icon.text : "";
}

function renderHighlightedText(text: string, query: string) {
  const words = query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return text;
  const pattern = `(${words.map(escapeRegex).join("|")})`;
  const splitRe = new RegExp(pattern, "gi");
  const checkRe = new RegExp(pattern, "i");
  const parts = text.split(splitRe);
  return (
    <>
      {parts.map((part, idx) =>
        checkRe.test(part)
          ? (
            <mark key={idx} className="rounded-sm bg-yellow-200 text-slate-950">
              {part}
            </mark>
          )
          : <span key={idx}>{part}</span>
      )}
    </>
  );
}

function renderIcon(icon: any) {
  if (!icon) return "";
  if (typeof icon === "string") return icon;
  if (icon.text) return icon.text;
  if (icon.base64) return "📷";
  return "";
}

function formatDate(date: Date | string | undefined) {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDateTime(date: Date | string | undefined) {
  if (!date) return null;
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(
  startDate: Date | string,
  endDate?: Date | string | null,
): string {
  const start = typeof startDate === "string" ? new Date(startDate) : startDate;
  const end = endDate
    ? (typeof endDate === "string" ? new Date(endDate) : endDate)
    : new Date();

  const diffMs = end.getTime() - start.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "< 1 min";
  if (diffMins < 60) return `${diffMins} min`;
  if (diffHours < 24) {
    const mins = diffMins % 60;
    return mins > 0 ? `${diffHours}h ${mins}m` : `${diffHours}h`;
  }
  if (diffDays < 7) {
    const hours = diffHours % 24;
    return hours > 0 ? `${diffDays}d ${hours}h` : `${diffDays}d`;
  }
  return `${diffDays} days`;
}

function getObjectType(
  object: ObjectModel,
):
  | "person"
  | "event"
  | "relationship"
  | "promise"
  | "conversation"
  | "tag"
  | "place"
  | "organization"
  | "product"
  | "project"
  | "animal"
  | "concept"
  | "media"
  | "other" {
  if (object.isPromise) return "promise";
  if (object.isTag) return "tag";
  if (object.isRelationship) return "relationship";
  if (object.isConversation) return "conversation";
  if (object.isPerson) return "person";
  if (object.isEvent) return "event";
  if (object.isPlace) return "place";
  if (object.isOrganization) return "organization";
  if (object.isProduct) return "product";
  if (object.isProject) return "project";
  if (object.isAnimal) return "animal";
  if (object.isConcept) return "concept";
  if (object.isMedia) return "media";
  return "other";
}

const TYPE_CONFIG = {
  person: {
    label: "People",
    icon: User,
    color: "bg-blue-100 text-blue-800 border-blue-200",
    badgeVariant: "secondary" as const,
  },
  event: {
    label: "Events",
    icon: Calendar,
    color: "bg-green-100 text-green-800 border-green-200",
    badgeVariant: "secondary" as const,
  },
  relationship: {
    label: "Relationships",
    icon: Users,
    color: "bg-purple-100 text-purple-800 border-purple-200",
    badgeVariant: "secondary" as const,
  },
  promise: {
    label: "Promises",
    icon: Handshake,
    color: "bg-orange-100 text-orange-800 border-orange-200",
    badgeVariant: "secondary" as const,
  },
  conversation: {
    label: "Conversations",
    icon: MessageSquare,
    color: "bg-cyan-100 text-cyan-800 border-cyan-200",
    badgeVariant: "secondary" as const,
  },
  tag: {
    label: "Tags",
    icon: Tag,
    color: "bg-pink-100 text-pink-800 border-pink-200",
    badgeVariant: "secondary" as const,
  },
  place: {
    label: "Places",
    icon: MapPin,
    color: "bg-teal-100 text-teal-800 border-teal-200",
    badgeVariant: "secondary" as const,
  },
  organization: {
    label: "Organizations",
    icon: Building2,
    color: "bg-indigo-100 text-indigo-800 border-indigo-200",
    badgeVariant: "secondary" as const,
  },
  product: {
    label: "Products",
    icon: Box,
    color: "bg-amber-100 text-amber-800 border-amber-200",
    badgeVariant: "secondary" as const,
  },
  project: {
    label: "Projects",
    icon: FolderKanban,
    color: "bg-violet-100 text-violet-800 border-violet-200",
    badgeVariant: "secondary" as const,
  },
  animal: {
    label: "Animals",
    icon: PawPrint,
    color: "bg-lime-100 text-lime-800 border-lime-200",
    badgeVariant: "secondary" as const,
  },
  concept: {
    label: "Concepts",
    icon: Lightbulb,
    color: "bg-sky-100 text-sky-800 border-sky-200",
    badgeVariant: "secondary" as const,
  },
  media: {
    label: "Media",
    icon: Film,
    color: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
    badgeVariant: "secondary" as const,
  },
  other: {
    label: "Other",
    icon: Package,
    color: "bg-gray-100 text-gray-800 border-gray-200",
    badgeVariant: "secondary" as const,
  },
};

interface ObjectCardProps {
  object: ObjectModel & {
    subjectObject?: ObjectModel;
    objectObject?: ObjectModel;
    referencesToCount?: number;
    referencesFromCount?: number;
    tags?: Array<
      { _id: string; name?: string; icon?: unknown; color?: string }
    >;
    linkedObjectsCount?: number; // For tags: number of objects linked to this tag
  };
  searchQuery: string;
  showType?: boolean;
  onToggleStar?: (objectId: string, currentStarred: boolean) => void;
}

function ObjectCard(
  { object, searchQuery, showType = false, onToggleStar }: ObjectCardProps,
) {
  const isRelationship = object.isRelationship;
  const isConversation = object.isConversation;
  const hasRelationshipData = object.relationship && object.subjectObject &&
    object.objectObject;
  const objectType = getObjectType(object);
  const typeConfig = TYPE_CONFIG[objectType];

  const timeRangeInfo = useMemo(() => {
    if (!object.timeRanges || object.timeRanges.length === 0) return null;
    const first = object.timeRanges[0];
    const hasEnd = !!first.end;
    return {
      start: first.start,
      end: first.end,
      startFormatted: formatDate(first.start),
      startDateTime: formatDateTime(first.start),
      endFormatted: hasEnd ? formatDate(first.end) : null,
      duration: formatDuration(first.start, first.end),
      count: object.timeRanges.length,
      hasEnd,
    };
  }, [object.timeRanges]);

  const handleStarClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onToggleStar?.(object._id.toString(), !!object.starred);
  };

  return (
    <article className="relative min-w-0">
      <Link className="block h-full rounded-lg focus-visible:outline focus-visible:outline-ring" to={`/objects/${object._id.toString()}`}>
        <Card className="relative h-full rounded-lg bg-card p-3 shadow-none transition-colors hover:border-primary">
          <div className="space-y-1">
            {/* Header with icon and name */}
            <div className="flex min-w-0 items-center gap-2 pr-6">
              <span
                className="text-base flex-shrink-0 w-6 h-6 flex items-center justify-center rounded"
                style={{
                  backgroundColor: object.color ? `${object.color}20` : undefined,
                }}
              >
                {renderIcon(object.icon)}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="line-clamp-2 break-words text-base font-semibold leading-snug">
                    {searchQuery.trim() && object.name
                      ? renderHighlightedText(object.name, searchQuery.trim())
                      : object.name || "Unnamed"}
                  </span>
                  {showType && (
                    <Badge
                      variant="outline"
                      className={`text-xs px-1 py-0 ${typeConfig.color}`}
                    >
                      {objectType === "other" ? "Object" : objectType}
                    </Badge>
                  )}
                  {/* Show linked objects count for tags */}
                  {objectType === "tag" &&
                    object.linkedObjectsCount !== undefined && (
                    <Badge variant="secondary" className="text-xs px-1 py-0">
                      {object.linkedObjectsCount}{" "}
                      {object.linkedObjectsCount === 1 ? "object" : "objects"}
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            {/* Relationship info - compact */}
            {isRelationship && hasRelationshipData && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground pl-8 truncate">
                <span>{object.subjectObject?.name}</span>
                {object.relationship?.symmetrical
                  ? <ArrowLeftRight className="w-3 h-3 flex-shrink-0" />
                  : <ArrowRight className="w-3 h-3 flex-shrink-0" />}
                <span className="truncate">{object.objectObject?.name}</span>
              </div>
            )}

            {/* Details - truncated to 2 lines */}
            {object.details && !isRelationship && (
              <div className="line-clamp-2 break-words pl-8 text-sm leading-snug text-muted-foreground">
                {object.details}
              </div>
            )}

            {/* Metadata row - compact */}
            <div className="flex items-center gap-2 text-xs text-muted-foreground pl-8 flex-wrap">
              {/* Conversation: duration and time */}
              {isConversation && timeRangeInfo && (
                <>
                  <span>{timeRangeInfo.duration}</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span>{timeRangeInfo.startDateTime}</span>
                </>
              )}
              {/* Non-conversation: date range */}
              {!isConversation && timeRangeInfo && (
                <div className="flex items-center gap-1">
                  <CalendarClock className="w-2.5 h-2.5" />
                  <span>{timeRangeInfo.startFormatted}</span>
                  {timeRangeInfo.count > 1 && (
                    <span className="text-muted-foreground">
                      (+{timeRangeInfo.count - 1})
                    </span>
                  )}
                </div>
              )}
              {/* Aliases - show only if no details */}
              {object.aliases && object.aliases.length > 0 && !object.details &&
                !isConversation && (
                <span className="truncate">
                  aka {object.aliases.slice(0, 2).join(", ")}
                </span>
              )}
            </div>

            {/* Tags row */}
            {object.tags && object.tags.length > 0 && (
              <div className="flex items-center gap-1 pl-8 flex-wrap">
                <Tag className="w-2.5 h-2.5 text-muted-foreground" />
                {object.tags.slice(0, 3).map((
                  tag: { _id: string; name?: string; color?: string },
                ) => (
                  <Badge
                    key={tag._id}
                    variant="outline"
                    className="text-xs px-1 py-0"
                    style={tag.color
                      ? { borderColor: tag.color, color: tag.color }
                      : undefined}
                  >
                    {tag.name || "Unnamed"}
                  </Badge>
                ))}
                {object.tags.length > 3 && (
                  <span className="text-xs text-muted-foreground">
                    +{object.tags.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>
        </Card>
      </Link>
      {onToggleStar && (
        <button
          type="button"
          onClick={handleStarClick}
          className={`absolute right-1 top-1 flex size-8 items-center justify-center rounded-md transition-colors ${
            object.starred
              ? "text-yellow-500 hover:text-yellow-600"
              : "text-muted-foreground hover:bg-muted hover:text-yellow-700"
          }`}
          title={object.starred ? "Remove from starred" : "Add to starred"}
        >
          <Star
            className={`w-3.5 h-3.5 ${object.starred ? "fill-current" : ""}`}
          />
        </button>
      )}
    </article>
  );
}

type ObjectType =
  | "person"
  | "event"
  | "relationship"
  | "promise"
  | "conversation"
  | "tag"
  | "place"
  | "organization"
  | "product"
  | "project"
  | "animal"
  | "concept"
  | "media"
  | "other";
type SortOption = "name" | "updatedAt" | "createdAt";

interface TypeFilterButtonProps {
  type: ObjectType;
  count: number;
  isActive: boolean;
  onClick: () => void;
}

function TypeFilterButton(
  { type, count, isActive, onClick }: TypeFilterButtonProps,
) {
  const config = TYPE_CONFIG[type];
  const Icon = config.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={`
        flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 transition-colors
        ${
        isActive
          ? `${config.color} border-current`
          : "bg-background border-border hover:bg-muted"
      }
      `}
    >
      <Icon className="w-4 h-4" />
      <span className="text-sm font-medium">{config.label}</span>
      <Badge variant="secondary" className="border-0 px-1.5 text-xs tabular-nums">
        {count}
      </Badge>
    </button>
  );
}

type ObjectWithRelations = ObjectModel & {
  subjectObject?: ObjectModel;
  objectObject?: ObjectModel;
  referencesToCount?: number;
  referencesFromCount?: number;
  tags?: Array<{ _id: string; name?: string; icon?: unknown; color?: string }>;
  linkedObjectsCount?: number; // For tags: number of objects linked to this tag
};

const ITEMS_PER_TYPE = 9; // Initial items per type (3 rows of 3)
const LOAD_MORE_COUNT = 30; // Items to load when clicking "load more"
const MAX_ITEMS_PER_TYPE = 300; // Maximum items per type for "load all"
const MAX_CONCURRENT_SECTION_REQUESTS = 2;
const SECTION_REFRESH_INTERVAL_MS = 60_000;
const SECTION_OBSERVER_ROOT_MARGIN = "400px 0px";
const ORPHAN_COUNT_POLL_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000] as const;

const ALL_OBJECT_TYPES: ObjectType[] = [
  "person",
  "event",
  "relationship",
  "promise",
  "conversation",
  "tag",
  "place",
  "organization",
  "product",
  "project",
  "animal",
  "concept",
  "media",
  "other",
];

function createTypeRecord<T>(
  factory: (type: ObjectType) => T,
): Record<ObjectType, T> {
  return Object.fromEntries(
    ALL_OBJECT_TYPES.map((type) => [type, factory(type)]),
  ) as Record<ObjectType, T>;
}

interface ListCardsResponse {
  items: ObjectWithRelations[];
  nextCursor?: string | null;
  hasMore: boolean;
}

type TypeFetchMode = "initial" | "refresh" | "append";

interface BrowseTask {
  key: string;
  generation: number | null;
  run: () => Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

const ObjectsPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [objectsByType, setObjectsByType] = useState<
    Record<ObjectType, ObjectWithRelations[]>
  >(
    () => createTypeRecord(() => []),
  );
  const [loadingTypes, setLoadingTypes] = useState<Set<ObjectType>>(new Set());
  const [fetchedTypes, setFetchedTypes] = useState<Set<ObjectType>>(new Set());
  const [typeErrors, setTypeErrors] = useState<
    Record<ObjectType, string | null>
  >(
    () => createTypeRecord(() => null),
  );

  // Collapsed state per type - start expanded by default
  const [collapsed, setCollapsed] = useState<Record<ObjectType, boolean>>(
    () => createTypeRecord(() => false),
  );

  // Section-specific sort (for conversations: chronological vs recent)
  type SectionSortOption = "default" | "chronological" | "chronological-desc";
  const [sectionSort, setSectionSort] = useState<
    Record<ObjectType, SectionSortOption>
  >(
    () =>
      createTypeRecord((type) =>
        type === "conversation" ? "chronological-desc" : "default"
      ),
  );

  // Total counts per type from database
  const [totalCounts, setTotalCounts] = useState<Record<ObjectType, number>>(
    () => createTypeRecord(() => 0),
  );
  const [countsLoading, setCountsLoading] = useState(true);
  const [orphanedCount, setOrphanedCount] = useState<number | null>(null);
  const [orphanedRefreshing, setOrphanedRefreshing] = useState(false);

  const [mightHaveMore, setMightHaveMore] = useState<
    Record<ObjectType, boolean>
  >(
    () => createTypeRecord(() => false),
  );

  // Starred objects section
  const [starredObjects, setStarredObjects] = useState<ObjectWithRelations[]>(
    [],
  );
  const [starredCollapsed, setStarredCollapsed] = useState(false);
  const [starredLoading, setStarredLoading] = useState(false);
  const [starredError, setStarredError] = useState<string | null>(null);
  const [starredHasMore, setStarredHasMore] = useState(false);

  // Duplicates scan
  const [showDuplicates, setShowDuplicates] = useState(false);
  const { data: duplicateGroups = [], isLoading: duplicateGroupsLoading } =
    useDuplicateGroups(showDuplicates);
  const [mergePair, setMergePair] = useState<
    { current: ObjectModel; otherId: string } | null
  >(null);

  const q = searchParams.get("q") || "";
  const sortBy = (searchParams.get("sort") as SortOption) || "updatedAt";
  // Get active type filters from URL (comma-separated)
  const activeTypesParam = searchParams.get("types") || "";
  const activeTypes = useMemo(() => {
    if (!activeTypesParam) return new Set<ObjectType>();
    return new Set(activeTypesParam.split(",").filter(Boolean) as ObjectType[]);
  }, [activeTypesParam]);
  // Get orphaned filter from URL
  const showOrphanedOnly = searchParams.get("orphaned") === "true";

  // Tag filter: ?tag=<id>[,<id>...] with AND (default) or OR semantics.
  const tagParam = searchParams.get("tag") || "";
  const tagMode: "and" | "or" = searchParams.get("tagMode") === "or"
    ? "or"
    : "and";
  const activeTagIds = useMemo(
    () => tagParam.split(",").filter(Boolean),
    [tagParam],
  );
  const [localQ, setLocalQ] = useState(q);
  const [allTags, setAllTags] = useState<ObjectWithRelations[]>([]);
  const tagOptionsControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    tagOptionsControllerRef.current?.abort();
    tagOptionsControllerRef.current = controller;
    const timer = globalThis.setTimeout(() => {
      void callResource("objects", {
        action: "listTagOptions",
        ids: activeTagIds.length > 0 ? activeTagIds : undefined,
        search: localQ.trim() || undefined,
        limit: 32,
      }, { signal: controller.signal }).then((result) => {
        if (!controller.signal.aborted && Array.isArray(result?.items)) {
          setAllTags(result.items);
        }
      }).catch((error) => {
        if (!isAbortError(error)) {
          console.error("Failed to load bounded tag options:", error);
        }
      });
    }, 250);
    return () => {
      globalThis.clearTimeout(timer);
      controller.abort();
      if (tagOptionsControllerRef.current === controller) {
        tagOptionsControllerRef.current = null;
      }
    };
  }, [activeTagIds, localQ]);

  const mountedRef = useRef(true);
  const filterGenerationRef = useRef(0);
  const lastFilterSignatureRef = useRef<string | null>(null);
  const objectsByTypeRef = useRef(objectsByType);
  const fetchedTypesRef = useRef<Set<ObjectType>>(new Set());
  const failedTypesRef = useRef<Set<ObjectType>>(new Set());
  const loadingTypesRef = useRef<Set<ObjectType>>(new Set());
  const scheduledTypesRef = useRef<Set<ObjectType>>(new Set());
  const cursorsRef = useRef<Record<ObjectType, string | null>>(
    createTypeRecord(() => null),
  );
  const collapsedRef = useRef(collapsed);
  const lastFetchedAtRef = useRef<Record<ObjectType, number>>(
    createTypeRecord(() => 0),
  );
  const visibleSectionsRef = useRef<Set<ObjectType>>(new Set());
  const sectionNodesRef = useRef<Map<ObjectType, HTMLElement>>(new Map());
  const sectionNodeCallbacksRef = useRef<
    Map<ObjectType, (node: HTMLDivElement | null) => void>
  >(new Map());
  const sectionObserverRef = useRef<IntersectionObserver | null>(null);
  const queueRef = useRef<BrowseTask[]>([]);
  const queuedTaskKeysRef = useRef<Set<string>>(new Set());
  const activeTaskCountRef = useRef(0);
  const starredFetchedRef = useRef(false);
  const starredObjectsRef = useRef<ObjectWithRelations[]>([]);
  const starredCursorRef = useRef<string | null>(null);
  const starredLoadingRef = useRef(false);
  const starredScheduledRef = useRef(false);
  const starredLastFetchedAtRef = useRef(0);
  const cardsInFlightRef = useRef<
    Map<
      string,
      {
        promise: Promise<ListCardsResponse>;
        controller: AbortController;
        section: ObjectType | "starred";
      }
    >
  >(new Map());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // StrictMode replays effects. Deferring teardown lets the replay reuse
      // the same request while a real unmount still aborts it immediately after.
      globalThis.setTimeout(() => {
        if (mountedRef.current) return;
        queueRef.current = [];
        queuedTaskKeysRef.current.clear();
        scheduledTypesRef.current.clear();
        for (const request of cardsInFlightRef.current.values()) {
          request.controller.abort();
        }
        cardsInFlightRef.current.clear();
      }, 0);
    };
  }, []);

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => {
    starredObjectsRef.current = starredObjects;
  }, [starredObjects]);

  const setTypeLoading = useCallback((type: ObjectType, loading: boolean) => {
    const next = new Set(loadingTypesRef.current);
    if (loading) next.add(type);
    else next.delete(type);
    loadingTypesRef.current = next;
    if (mountedRef.current) setLoadingTypes(next);
  }, []);

  const requestListCards = useCallback((
    section: ObjectType | "starred",
    body: Record<string, unknown>,
  ): Promise<ListCardsResponse> => {
    const requestKey = JSON.stringify(body);
    const existing = cardsInFlightRef.current.get(requestKey);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise: Promise<ListCardsResponse> = callResource(
      "objects",
      body,
      { signal: controller.signal },
    )
      .finally(() => {
        if (cardsInFlightRef.current.get(requestKey)?.promise === promise) {
          cardsInFlightRef.current.delete(requestKey);
        }
      });
    cardsInFlightRef.current.set(requestKey, { promise, controller, section });
    return promise;
  }, []);

  const abortTypeRequests = useCallback(() => {
    for (const [key, request] of cardsInFlightRef.current) {
      if (request.section === "starred") continue;
      request.controller.abort();
      cardsInFlightRef.current.delete(key);
    }
  }, []);

  const pumpBrowseQueue = useCallback(() => {
    if (!mountedRef.current) return;
    while (
      activeTaskCountRef.current < MAX_CONCURRENT_SECTION_REQUESTS &&
      queueRef.current.length > 0
    ) {
      const task = queueRef.current.shift()!;
      if (
        task.generation !== null &&
        task.generation !== filterGenerationRef.current
      ) {
        queuedTaskKeysRef.current.delete(task.key);
        continue;
      }

      activeTaskCountRef.current += 1;
      void task.run().finally(() => {
        activeTaskCountRef.current -= 1;
        queuedTaskKeysRef.current.delete(task.key);
        queueMicrotask(pumpBrowseQueue);
      });
    }
  }, []);

  const enqueueBrowseTask = useCallback((task: BrowseTask) => {
    if (!mountedRef.current || queuedTaskKeysRef.current.has(task.key)) return;
    queuedTaskKeysRef.current.add(task.key);
    queueRef.current.push(task);
    pumpBrowseQueue();
  }, [pumpBrowseQueue]);

  const fetchTypePage = useCallback(async (
    type: ObjectType,
    mode: TypeFetchMode,
    generation: number,
  ) => {
    const previousItems = objectsByTypeRef.current[type];
    const cursor = mode === "append" ? cursorsRef.current[type] : undefined;
    const limit = mode === "initial"
      ? ITEMS_PER_TYPE
      : mode === "append"
      ? Math.min(LOAD_MORE_COUNT, MAX_ITEMS_PER_TYPE - previousItems.length)
      : Math.min(Math.max(previousItems.length, ITEMS_PER_TYPE), 50);

    setTypeLoading(type, true);
    if (mountedRef.current) {
      setTypeErrors((prev) => ({ ...prev, [type]: null }));
    }

    try {
      const result = await requestListCards(type, {
        action: "listCards",
        section: type,
        filters: {
          search: q.trim() || undefined,
          tagIds: activeTagIds.length > 0 ? activeTagIds : undefined,
          tagMode,
          orphanedOnly: showOrphanedOnly || undefined,
        },
        sort: sortBy,
        cursor,
        limit,
      });

      if (!mountedRef.current || generation !== filterGenerationRef.current) {
        return;
      }

      const items = Array.isArray(result?.items) ? result.items : [];
      failedTypesRef.current.delete(type);
      setObjectsByType((prev) => {
        let nextItems = items;
        if (mode === "append") {
          const ids = new Set(prev[type].map((item) => item._id.toString()));
          nextItems = [
            ...prev[type],
            ...items.filter((item) => !ids.has(item._id.toString())),
          ];
        }
        const next = { ...prev, [type]: nextItems };
        objectsByTypeRef.current = next;
        return next;
      });

      cursorsRef.current[type] = result?.nextCursor ?? null;
      const nextFetched = new Set(fetchedTypesRef.current).add(type);
      fetchedTypesRef.current = nextFetched;
      setFetchedTypes(nextFetched);
      setMightHaveMore((prev) => ({
        ...prev,
        [type]: Boolean(result?.hasMore) && (
          mode !== "append" ||
          previousItems.length + items.length < MAX_ITEMS_PER_TYPE
        ),
      }));
      lastFetchedAtRef.current[type] = Date.now();
    } catch (error) {
      if (
        !isAbortError(error) &&
        mountedRef.current &&
        generation === filterGenerationRef.current
      ) {
        failedTypesRef.current.add(type);
        console.error(`Failed to fetch ${type}:`, error);
        setTypeErrors((prev) => ({ ...prev, [type]: errorMessage(error) }));
      }
    } finally {
      if (generation === filterGenerationRef.current) {
        setTypeLoading(type, false);
      }
    }
  }, [
    activeTagIds,
    q,
    requestListCards,
    setTypeLoading,
    showOrphanedOnly,
    sortBy,
    tagMode,
  ]);

  const enqueueTypeFetch = useCallback((
    type: ObjectType,
    mode: TypeFetchMode = "initial",
    force = false,
  ) => {
    const generation = filterGenerationRef.current;
    if (collapsedRef.current[type] || scheduledTypesRef.current.has(type)) {
      return;
    }
    if (loadingTypesRef.current.has(type)) return;
    if (force) failedTypesRef.current.delete(type);
    if (
      !force && mode === "initial" && failedTypesRef.current.has(type)
    ) {
      return;
    }
    if (!force && mode === "initial" && fetchedTypesRef.current.has(type)) {
      return;
    }
    if (mode === "refresh" && !fetchedTypesRef.current.has(type)) return;
    if (mode === "append") {
      if (!fetchedTypesRef.current.has(type) || !cursorsRef.current[type]) {
        return;
      }
      if (objectsByTypeRef.current[type].length >= MAX_ITEMS_PER_TYPE) return;
    }

    scheduledTypesRef.current.add(type);
    enqueueBrowseTask({
      key: `${generation}:${type}:${mode}`,
      generation,
      run: async () => {
        try {
          await fetchTypePage(type, mode, generation);
        } finally {
          if (generation === filterGenerationRef.current) {
            scheduledTypesRef.current.delete(type);
          }
        }
      },
    });
  }, [enqueueBrowseTask, fetchTypePage]);

  const enqueueTypeFetchRef = useRef(enqueueTypeFetch);
  enqueueTypeFetchRef.current = enqueueTypeFetch;

  const fetchStarredPage = useCallback(async (mode: TypeFetchMode) => {
    const previousItems = starredObjectsRef.current;
    const cursor = mode === "append" ? starredCursorRef.current : undefined;
    const limit = mode === "initial"
      ? ITEMS_PER_TYPE
      : mode === "append"
      ? Math.min(LOAD_MORE_COUNT, MAX_ITEMS_PER_TYPE - previousItems.length)
      : Math.min(Math.max(previousItems.length, ITEMS_PER_TYPE), 50);
    starredLoadingRef.current = true;
    if (mountedRef.current) {
      setStarredLoading(true);
      setStarredError(null);
    }
    try {
      const result = await requestListCards("starred", {
        action: "listCards",
        section: "starred",
        sort: "updatedAt",
        cursor,
        limit,
      });
      if (!mountedRef.current) return;
      const items = Array.isArray(result?.items) ? result.items : [];
      let nextItems = items;
      if (mode === "append") {
        const ids = new Set(previousItems.map((item) => item._id.toString()));
        nextItems = [
          ...previousItems,
          ...items.filter((item) => !ids.has(item._id.toString())),
        ];
      }
      starredObjectsRef.current = nextItems;
      setStarredObjects(nextItems);
      starredCursorRef.current = result?.nextCursor ?? null;
      setStarredHasMore(
        Boolean(result?.hasMore) && nextItems.length < MAX_ITEMS_PER_TYPE,
      );
      starredFetchedRef.current = true;
      starredLastFetchedAtRef.current = Date.now();
    } catch (error) {
      if (!isAbortError(error) && mountedRef.current) {
        console.error("Failed to fetch starred objects:", error);
        setStarredError(errorMessage(error));
      }
    } finally {
      starredLoadingRef.current = false;
      if (mountedRef.current) setStarredLoading(false);
    }
  }, [requestListCards]);

  const enqueueStarredFetch = useCallback((
    force = false,
    mode: TypeFetchMode = force ? "refresh" : "initial",
  ) => {
    if (starredScheduledRef.current || starredLoadingRef.current) return;
    if (!force && mode === "initial" && starredFetchedRef.current) return;
    if (mode === "append") {
      if (!starredFetchedRef.current || !starredCursorRef.current) return;
      if (starredObjectsRef.current.length >= MAX_ITEMS_PER_TYPE) return;
    }
    starredScheduledRef.current = true;
    enqueueBrowseTask({
      key: `starred:${mode}`,
      generation: null,
      run: async () => {
        try {
          await fetchStarredPage(mode);
        } finally {
          starredScheduledRef.current = false;
        }
      },
    });
  }, [enqueueBrowseTask, fetchStarredPage]);

  // Fetch total counts per type from cached API (no search filter - absolute counts)
  const fetchCounts = useCallback(async (forceRefresh = false) => {
    setCountsLoading(true);
    try {
      const result = await callResource("objects", {
        action: "getCounts",
        forceRefresh,
      });

      if (result) {
        setTotalCounts({
          person: result.person || 0,
          event: result.event || 0,
          relationship: result.relationship || 0,
          promise: result.promise || 0,
          conversation: result.conversation || 0,
          tag: result.tag || 0,
          place: result.place || 0,
          organization: result.organization || 0,
          product: result.product || 0,
          project: result.project || 0,
          animal: result.animal || 0,
          concept: result.concept || 0,
          media: result.media || 0,
          other: result.other || 0,
        });
        // Orphaned might be null if calculating in background
        setOrphanedCount(result.orphaned ?? null);
        const orphanStatus = result.meta?.orphaned?.status;
        setOrphanedRefreshing(
          result.orphanedLoading || orphanStatus === "refreshing",
        );
      } else {
        setTotalCounts(createTypeRecord(() => 0));
        setOrphanedCount(null);
        setOrphanedRefreshing(false);
      }
    } catch (err) {
      console.error("Failed to fetch counts:", err);
    } finally {
      setCountsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!orphanedRefreshing) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const schedulePoll = (attempt: number) => {
      if (cancelled) return;
      if (attempt >= ORPHAN_COUNT_POLL_BACKOFF_MS.length) {
        setOrphanedRefreshing(false);
        return;
      }

      timer = globalThis.setTimeout(async () => {
        timer = null;
        if (cancelled) return;

        controller = new AbortController();
        let keepPolling = true;
        try {
          const updated = await callResource("objects", {
            action: "getCounts",
            forceRefresh: false,
          }, { signal: controller.signal });
          if (cancelled) return;
          if (updated?.orphaned != null) {
            setOrphanedCount(updated.orphaned);
          }
          keepPolling = updated?.orphanedLoading === true ||
            updated?.meta?.orphaned?.status === "refreshing";
        } catch (error) {
          if (isAbortError(error) || cancelled) return;
          // A transient read failure consumes this attempt and retries with
          // backoff. The loop remains bounded, so it cannot poll forever.
        } finally {
          controller = null;
        }

        if (cancelled) return;
        if (keepPolling) schedulePoll(attempt + 1);
        else setOrphanedRefreshing(false);
      }, ORPHAN_COUNT_POLL_BACKOFF_MS[attempt]);
    };

    schedulePoll(0);
    return () => {
      cancelled = true;
      if (timer) globalThis.clearTimeout(timer);
      controller?.abort();
    };
  }, [orphanedRefreshing]);

  useEffect(() => {
    fetchCounts();
  }, [fetchCounts]);

  useEffect(() => {
    enqueueStarredFetch();
  }, [enqueueStarredFetch]);

  const filterSignature = useMemo(() =>
    JSON.stringify({
      q: q.trim(),
      sortBy,
      showOrphanedOnly,
      tagParam,
      tagMode,
    }), [q, showOrphanedOnly, sortBy, tagMode, tagParam]);

  // Invalidate old pages immediately. The response generation check is a
  // second guard for servers that finish work before the abort reaches them.
  useEffect(() => {
    if (lastFilterSignatureRef.current === filterSignature) return;
    lastFilterSignatureRef.current = filterSignature;
    filterGenerationRef.current += 1;
    abortTypeRequests();

    const retained = queueRef.current.filter((task) =>
      task.generation === null
    );
    for (const task of queueRef.current) {
      if (task.generation !== null) queuedTaskKeysRef.current.delete(task.key);
    }
    queueRef.current = retained;
    scheduledTypesRef.current.clear();
    loadingTypesRef.current = new Set();
    setLoadingTypes(new Set());
    fetchedTypesRef.current = new Set();
    failedTypesRef.current.clear();
    setFetchedTypes(new Set());
    cursorsRef.current = createTypeRecord(() => null);
    lastFetchedAtRef.current = createTypeRecord(() => 0);
    const emptyObjects = createTypeRecord<ObjectWithRelations[]>(() => []);
    objectsByTypeRef.current = emptyObjects;
    setObjectsByType(emptyObjects);
    setMightHaveMore(createTypeRecord(() => false));
    setTypeErrors(createTypeRecord(() => null));

    queueMicrotask(() => {
      for (const type of visibleSectionsRef.current) {
        if (!collapsedRef.current[type]) enqueueTypeFetchRef.current(type);
      }
    });
  }, [abortTypeRequests, filterSignature]);

  const registerSectionNode = useCallback(
    (type: ObjectType, node: HTMLElement | null) => {
      const previous = sectionNodesRef.current.get(type);
      if (previous && previous !== node) {
        sectionObserverRef.current?.unobserve(previous);
      }
      if (!node) {
        sectionNodesRef.current.delete(type);
        visibleSectionsRef.current.delete(type);
        return;
      }
      sectionNodesRef.current.set(type, node);
      if (typeof IntersectionObserver === "undefined") {
        visibleSectionsRef.current.add(type);
        if (!collapsedRef.current[type]) enqueueTypeFetchRef.current(type);
      } else {
        sectionObserverRef.current?.observe(node);
      }
    },
    [],
  );

  const getSectionNodeRef = useCallback((type: ObjectType) => {
    const existing = sectionNodeCallbacksRef.current.get(type);
    if (existing) return existing;
    const callback = (node: HTMLDivElement | null) => {
      registerSectionNode(type, node);
    };
    sectionNodeCallbacksRef.current.set(type, callback);
    return callback;
  }, [registerSectionNode]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      for (const type of sectionNodesRef.current.keys()) {
        visibleSectionsRef.current.add(type);
        if (!collapsedRef.current[type]) enqueueTypeFetchRef.current(type);
      }
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const type = (entry.target as HTMLElement).dataset.objectSection as
          | ObjectType
          | undefined;
        if (!type || !ALL_OBJECT_TYPES.includes(type)) continue;
        if (entry.isIntersecting) {
          visibleSectionsRef.current.add(type);
          if (!collapsedRef.current[type]) enqueueTypeFetchRef.current(type);
        } else {
          visibleSectionsRef.current.delete(type);
        }
      }
    }, { rootMargin: SECTION_OBSERVER_ROOT_MARGIN });
    sectionObserverRef.current = observer;
    for (const node of sectionNodesRef.current.values()) observer.observe(node);

    return () => {
      observer.disconnect();
      if (sectionObserverRef.current === observer) {
        sectionObserverRef.current = null;
      }
    };
  }, []);

  // Refetch only visible, already-loaded sections that are actually stale.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (
        starredFetchedRef.current &&
        now - starredLastFetchedAtRef.current >= SECTION_REFRESH_INTERVAL_MS
      ) {
        enqueueStarredFetch(true);
      }
      for (const type of visibleSectionsRef.current) {
        if (
          !collapsedRef.current[type] &&
          fetchedTypesRef.current.has(type) &&
          now - lastFetchedAtRef.current[type] >= SECTION_REFRESH_INTERVAL_MS
        ) {
          enqueueTypeFetch(type, "refresh");
        }
      }
      void fetchCounts();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [enqueueStarredFetch, enqueueTypeFetch, fetchCounts]);

  // Load more for a specific type
  const loadMore = useCallback((type: ObjectType) => {
    enqueueTypeFetch(type, "append");
  }, [enqueueTypeFetch]);

  // Toggle star on an object
  const toggleStar = useCallback(
    async (objectId: string, currentStarred: boolean) => {
      const newStarred = !currentStarred;

      // Store the removed object for undo - we'll capture it via functional update
      let removedObject: ObjectWithRelations | undefined;
      // Store the found object when adding to starred
      let foundObject: ObjectWithRelations | undefined;

      // Optimistically update the UI - update both objectsByType and starredObjects
      setObjectsByType((prev) => {
        const updated = { ...prev };
        for (const type of Object.keys(updated) as ObjectType[]) {
          // While iterating, find the object if we're adding to starred
          if (newStarred && !foundObject) {
            const obj = updated[type].find((o) =>
              o._id.toString() === objectId
            );
            if (obj) foundObject = obj;
          }
          updated[type] = updated[type].map((obj) =>
            obj._id.toString() === objectId
              ? { ...obj, starred: newStarred }
              : obj
          );
        }
        return updated;
      });

      // Update starred objects list
      if (newStarred) {
        // Add to starred using the object found during objectsByType update
        // Use a small delay to ensure foundObject is captured from the synchronous setObjectsByType callback
        setStarredObjects((prev) => {
          const alreadyExists = prev.some((obj) =>
            obj._id.toString() === objectId
          );
          if (alreadyExists) return prev;
          if (foundObject) {
            return [{ ...foundObject, starred: true }, ...prev];
          }
          return prev;
        });
      } else {
        // Find and store the object before removing (for undo) using functional update
        setStarredObjects((prev) => {
          removedObject = prev.find((obj) => obj._id.toString() === objectId);
          return prev.filter((obj) => obj._id.toString() !== objectId);
        });
      }

      // Helper to revert changes
      const revertChanges = () => {
        setObjectsByType((prev) => {
          const updated = { ...prev };
          for (const type of Object.keys(updated) as ObjectType[]) {
            updated[type] = updated[type].map((obj) =>
              obj._id.toString() === objectId
                ? { ...obj, starred: currentStarred }
                : obj
            );
          }
          return updated;
        });
        if (removedObject) {
          setStarredObjects((prev) => [removedObject!, ...prev]);
        } else {
          setStarredObjects((prev) =>
            prev.filter((obj) => obj._id.toString() !== objectId)
          );
        }
      };

      try {
        // Get current version first
        const current = await callResource("objects", {
          action: "get",
          id: objectId,
        });

        await callResource("objects", {
          action: "update",
          id: objectId,
          version: current.version ?? 0,
          field: "starred",
          value: newStarred,
        });

        // Show undo toast when removing from starred
        if (!newStarred && removedObject) {
          // Capture the object data at this moment for the undo action
          const capturedObject = { ...removedObject };
          toast("Removed from starred", {
            action: {
              label: "Undo",
              onClick: async () => {
                // Optimistically restore the object to starred
                setStarredObjects((
                  prev,
                ) => [{ ...capturedObject, starred: true }, ...prev]);
                setObjectsByType((prev) => {
                  const updated = { ...prev };
                  for (const type of Object.keys(updated) as ObjectType[]) {
                    updated[type] = updated[type].map((obj) =>
                      obj._id.toString() === objectId
                        ? { ...obj, starred: true }
                        : obj
                    );
                  }
                  return updated;
                });

                try {
                  // Get current version and update
                  const current = await callResource("objects", {
                    action: "get",
                    id: objectId,
                  });
                  await callResource("objects", {
                    action: "update",
                    id: objectId,
                    version: current.version ?? 0,
                    field: "starred",
                    value: true,
                  });
                } catch (err) {
                  console.error("Failed to undo star removal:", err);
                  // Revert the optimistic update
                  setStarredObjects((prev) =>
                    prev.filter((obj) => obj._id.toString() !== objectId)
                  );
                  setObjectsByType((prev) => {
                    const updated = { ...prev };
                    for (const type of Object.keys(updated) as ObjectType[]) {
                      updated[type] = updated[type].map((obj) =>
                        obj._id.toString() === objectId
                          ? { ...obj, starred: false }
                          : obj
                      );
                    }
                    return updated;
                  });
                  toast.error("Failed to restore starred status");
                }
              },
            },
            duration: 5000,
          });
        }
      } catch (err) {
        console.error("Failed to toggle star:", err);
        revertChanges();
        toast.error("Failed to update starred status");
      }
    },
    [],
  );

  useEffect(() => {
    setLocalQ(q);
  }, [q]);

  function updateFilters(
    newQ: string,
    newTypes: Set<ObjectType>,
    newSort: SortOption,
    orphaned?: boolean,
  ) {
    const newSearchParams = new URLSearchParams();

    if (newQ.trim()) {
      newSearchParams.set("q", newQ.trim());
    }

    if (newTypes.size > 0) {
      newSearchParams.set("types", Array.from(newTypes).join(","));
    }

    if (newSort !== "updatedAt") {
      newSearchParams.set("sort", newSort);
    }

    if (orphaned !== undefined) {
      if (orphaned) {
        newSearchParams.set("orphaned", "true");
      } else {
        newSearchParams.delete("orphaned");
      }
    } else if (showOrphanedOnly) {
      newSearchParams.set("orphaned", "true");
    }

    // Preserve the active tag filter
    if (tagParam) {
      newSearchParams.set("tag", tagParam);
      if (tagMode === "or") {
        newSearchParams.set("tagMode", "or");
      }
    }

    setSearchParams(newSearchParams);
  }

  function toggleTagFilter(tagId: string) {
    const next = new Set(activeTagIds);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    const newSearchParams = new URLSearchParams(searchParams);
    if (next.size > 0) {
      newSearchParams.set("tag", Array.from(next).join(","));
    } else {
      newSearchParams.delete("tag");
      newSearchParams.delete("tagMode");
    }
    setSearchParams(newSearchParams);
  }

  function setTagFilterMode(mode: "and" | "or") {
    const newSearchParams = new URLSearchParams(searchParams);
    if (mode === "or") {
      newSearchParams.set("tagMode", "or");
    } else {
      newSearchParams.delete("tagMode");
    }
    setSearchParams(newSearchParams);
  }

  function toggleType(type: ObjectType) {
    const newTypes = new Set(activeTypes);
    if (newTypes.has(type)) {
      newTypes.delete(type);
    } else {
      newTypes.add(type);
    }
    updateFilters(q, newTypes, sortBy, showOrphanedOnly);
  }

  function toggleOrphaned() {
    updateFilters(q, activeTypes, sortBy, !showOrphanedOnly);
  }

  function toggleCollapsed(type: ObjectType) {
    const expanding = collapsedRef.current[type];
    const next = {
      ...collapsedRef.current,
      [type]: !collapsedRef.current[type],
    };
    collapsedRef.current = next;
    setCollapsed(next);
    if (expanding && visibleSectionsRef.current.has(type)) {
      enqueueTypeFetch(type);
    }
  }

  function clearAllFilters() {
    setLocalQ("");
    setSearchParams(new URLSearchParams());
  }

  // Total count across all types
  const grandTotal = useMemo(() => {
    return Object.values(totalCounts).reduce((sum, c) => sum + c, 0);
  }, [totalCounts]);

  // Determine which types to show based on filters
  // Order: conversations first, then people, events, relationships, promises, tags, other
  const visibleTypes = useMemo(() => {
    const typeOrder: ObjectType[] = [
      "conversation",
      "person",
      "event",
      "place",
      "organization",
      "product",
      "project",
      "animal",
      "concept",
      "media",
      "relationship",
      "promise",
      "tag",
      "other",
    ];

    if (activeTypes.size === 0) {
      // Show all types that have items (in database)
      return typeOrder.filter((type) => totalCounts[type] > 0);
    }
    // Show only selected types that have results
    return typeOrder.filter(
      (type) => activeTypes.has(type) && totalCounts[type] > 0,
    );
  }, [activeTypes, totalCounts]);

  const hasActiveFilters = q.trim() || activeTypes.size > 0 ||
    showOrphanedOnly || activeTagIds.length > 0;

  const filterCount = activeTypes.size + activeTagIds.length +
    Number(showOrphanedOnly) + Number(showDuplicates);

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Objects</h1>
        <Button asChild>
          <Link to="/objects/create">
            <Plus className="w-4 h-4 mr-2" />
            Create Object
          </Link>
        </Button>
      </div>

      {/* Search bar */}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          updateFilters(localQ, activeTypes, sortBy, showOrphanedOnly);
        }}
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={localQ}
            onChange={(e) => setLocalQ(e.target.value)}
            aria-label="Search objects"
            placeholder="Search by name, aliases, or details…"
            className="pl-9"
          />
        </div>
        <Button type="submit" disabled={loadingTypes.size > 0}>
          Search
        </Button>
      </form>

      {/* Type filters and sort */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2.5">
        <details className="group rounded-md border bg-background open:basis-full">
          <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md px-3 text-sm font-medium hover:bg-muted focus-visible:outline focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            Filters{filterCount > 0 && ` (${filterCount})`}
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t p-3">
            {/* Tag filter: active tags + suggestions narrowed by the search input */}
            {allTags.length > 0 && (() => {
              const activeTagObjects = activeTagIds
                .map((id) => ({
                  id,
                  tag: allTags.find((t) => t._id.toString() === id),
                }));
              const queryLower = localQ.trim().toLowerCase();
              const suggestions = allTags.filter((tag) => {
                const id = tag._id.toString();
                if (activeTagIds.includes(id)) return false;
                if (!queryLower) return true;
                return (tag.name ?? "").toLowerCase().includes(queryLower);
              });
              const visibleSuggestions = suggestions.slice(0, 12);
              const hiddenCount = suggestions.length - visibleSuggestions.length;
              return (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5 text-muted-foreground" />
                  {activeTagObjects.map(({ id, tag }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleTagFilter(id)}
                      title="Remove tag from filter"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary text-primary-foreground hover:opacity-80"
                    >
                      {tag ? `${iconText(tag.icon)} ` : ""}
                      {tag?.name ?? id}
                      <X className="w-3 h-3" />
                    </button>
                  ))}
                  {activeTagIds.length >= 2 && (
                    <button
                      type="button"
                      onClick={() =>
                        setTagFilterMode(tagMode === "and" ? "or" : "and")}
                      title={tagMode === "and"
                        ? "Objects must have ALL selected tags — click for ANY"
                        : "Objects may have ANY selected tag — click for ALL"}
                      className="px-1.5 py-0.5 rounded border text-xs font-mono text-muted-foreground hover:bg-muted"
                    >
                      {tagMode === "and" ? "&&" : "||"}
                    </button>
                  )}
                  {visibleSuggestions.map((tag) => (
                    <button
                      key={tag._id.toString()}
                      type="button"
                      onClick={() => toggleTagFilter(tag._id.toString())}
                      title={`Filter by tag "${tag.name}"`}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {`${iconText(tag.icon)} `}
                      {tag.name}
                    </button>
                  ))}
                  {hiddenCount > 0 && (
                    <span className="text-xs text-muted-foreground">
                      +{hiddenCount} more
                    </span>
                  )}
                </div>
              );
            })()}
            <div role="group" aria-label="Object types" className="flex flex-wrap gap-1.5">
              {(Object.keys(TYPE_CONFIG) as ObjectType[]).map((type) => (
                <TypeFilterButton
                  key={type}
                  type={type}
                  count={totalCounts[type]}
                  isActive={activeTypes.has(type)}
                  onClick={() => toggleType(type)}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t pt-3">
              {/* Orphaned filter */}
              <Button
                variant={showOrphanedOnly ? "secondary" : "outline"}
                size="sm"
                aria-pressed={showOrphanedOnly}
                onClick={toggleOrphaned}
                className="flex items-center gap-2"
              >
                {showOrphanedOnly
                  ? (
                    <>
                      <Link2Off className="w-4 h-4" />
                      Orphaned Only
                    </>
                  )
                  : (
                    <>
                      <Link2 className="w-4 h-4" />
                      Show Orphaned
                    </>
                  )}
                <Badge variant="secondary" className="text-xs ml-1">
                  {countsLoading
                    ? "..."
                    : (orphanedCount === null ? "..." : orphanedCount)}
                </Badge>
              </Button>

              {/* Duplicates scan */}
              <Button
                variant={showDuplicates ? "secondary" : "outline"}
                size="sm"
                aria-pressed={showDuplicates}
                onClick={() => setShowDuplicates((prev) => !prev)}
                className="flex items-center gap-2"
              >
                <Combine className="w-4 h-4" />
                Duplicates
                {showDuplicates && (
                  <Badge variant="secondary" className="text-xs ml-1">
                    {duplicateGroupsLoading ? "..." : duplicateGroups.length}
                  </Badge>
                )}
              </Button>

              {/* Refresh counts button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => fetchCounts(true)}
                disabled={countsLoading}
                className="flex items-center gap-1"
                title="Refresh counts"
              >
                <RefreshCw
                  className={`w-4 h-4 ${countsLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </div>
        </details>

        <div className="ml-auto flex items-center gap-2">
          <Label htmlFor="objects-sort" className="text-sm text-muted-foreground">Sort</Label>
          <Select
            value={sortBy}
            onValueChange={(value: SortOption) =>
              updateFilters(q, activeTypes, value, showOrphanedOnly)}
          >
            <SelectTrigger id="objects-sort" className="w-36 sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updatedAt">Last updated</SelectItem>
              <SelectItem value="createdAt">Last created</SelectItem>
              <SelectItem value="name">Name (A-Z)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Results summary */}
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <span className="text-muted-foreground">
          {countsLoading
            ? "Loading counts..."
            : hasActiveFilters
            ? `${
              activeTypes.size > 0
                ? Array.from(activeTypes).reduce(
                  (sum, t) => sum + totalCounts[t],
                  0,
                )
                : grandTotal
            } objects found`
            : `${grandTotal} objects in database`}
        </span>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAllFilters}
            className="h-7 text-xs"
          >
            <X className="w-3 h-3 mr-1" />
            Clear filters
          </Button>
        )}
      </div>

      {/* Results */}
      {grandTotal === 0 && !countsLoading && (
        <Card className="p-8 text-center">
          <Package className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">
            {hasActiveFilters
              ? "No objects found matching your filters."
              : "No objects found. Objects are created through the application."}
          </p>
          {hasActiveFilters && (
            <Button
              variant="link"
              onClick={clearAllFilters}
              className="mt-2"
            >
              Clear all filters
            </Button>
          )}
        </Card>
      )}

      {/* Duplicate groups panel */}
      {showDuplicates && (
        <div className="border border-amber-300 bg-amber-50/50 dark:border-amber-900/50 dark:bg-amber-900/10 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Combine className="w-5 h-5 text-amber-700" />
            <h2 className="text-lg font-semibold">Possible duplicates</h2>
            <Badge variant="outline" className="font-semibold">
              {duplicateGroupsLoading ? "..." : duplicateGroups.length}
            </Badge>
          </div>
          {duplicateGroupsLoading && (
            <p className="text-sm text-muted-foreground">
              Scanning for name collisions...
            </p>
          )}
          {!duplicateGroupsLoading && duplicateGroups.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No objects share a name or alias. 🎉
            </p>
          )}
          <div className="space-y-2">
            {duplicateGroups.map((group: any) => (
              <div
                key={group.key}
                className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
                    "{group.key}"
                  </span>
                  {group.objects.map((obj: any, index: number) => (
                    <span
                      key={obj._id.toString()}
                      className="flex items-center gap-2 min-w-0"
                    >
                      {index > 0 && (
                        <span className="text-muted-foreground">·</span>
                      )}
                      <Link
                        to={`/objects/${obj._id.toString()}`}
                        className="text-sm font-medium hover:underline truncate"
                      >
                        {obj.icon?.text ? `${obj.icon.text} ` : ""}
                        {obj.name ?? "Unnamed"}
                      </Link>
                    </span>
                  ))}
                </div>
                {group.objects.length === 2 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs flex-shrink-0"
                    onClick={() =>
                      setMergePair({
                        current: group.objects[0],
                        otherId: group.objects[1]._id.toString(),
                      })}
                  >
                    <Combine className="w-3 h-3 mr-1" />
                    Merge…
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {mergePair && (
        <MergeObjectDialog
          open={!!mergePair}
          onOpenChange={(open) => {
            if (!open) setMergePair(null);
          }}
          currentObject={mergePair.current}
          initialOtherId={mergePair.otherId}
        />
      )}

      {(grandTotal > 0 || countsLoading) && (
        <div className="space-y-4">
          {/* Starred Section - shown at top if there are starred objects */}
          {(starredObjects.length > 0 || starredLoading || starredError) && (
            <Collapsible
              open={!starredCollapsed}
              onOpenChange={() => setStarredCollapsed(!starredCollapsed)}
            >
              <div
                id="starred-section"
                className="border rounded-lg border-yellow-200 bg-yellow-50/30 dark:border-yellow-900/50 dark:bg-yellow-900/10"
              >
                <div className="flex flex-wrap items-center gap-2 px-3 py-3">
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2 flex-1 hover:bg-muted/50 -m-2 p-2 rounded transition-colors text-left"
                    >
                      {starredCollapsed
                        ? (
                          <ChevronRight className="w-5 h-5 text-muted-foreground" />
                        )
                        : (
                          <ChevronDown className="w-5 h-5 text-muted-foreground" />
                        )}
                      <Star className="w-5 h-5 text-yellow-500 fill-yellow-500" />
                      <h2 className="text-lg font-semibold">Starred</h2>
                      <Badge variant="outline" className="font-semibold">
                        {starredObjects.length}
                      </Badge>
                      <div className="flex-1" />
                    </button>
                  </CollapsibleTrigger>
                </div>

                <CollapsibleContent>
                  <div className="p-3 pt-0">
                    {starredError
                      ? (
                        <div className="min-h-16 flex flex-col items-center justify-center gap-2 text-sm text-destructive">
                          <span>Could not load starred objects.</span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => enqueueStarredFetch(true)}
                          >
                            Retry
                          </Button>
                        </div>
                      )
                      : starredLoading && starredObjects.length === 0
                      ? (
                        <p className="min-h-16 flex items-center justify-center text-sm text-muted-foreground">
                          Loading starred objects...
                        </p>
                      )
                      : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                          {starredObjects.map((object) => (
                            <ObjectCard
                              key={object._id.toString()}
                              object={object}
                              searchQuery={q}
                              showType
                              onToggleStar={toggleStar}
                            />
                          ))}
                        </div>
                      )}
                    {starredHasMore && starredObjects.length > 0 && (
                      <div className="mt-3 flex items-center justify-center">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => enqueueStarredFetch(false, "append")}
                          disabled={starredLoading}
                        >
                          {starredLoading ? "Loading..." : "Load more starred"}
                        </Button>
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </div>
            </Collapsible>
          )}

          {visibleTypes.map((type) => {
            const typeObjects = objectsByType[type];
            const config = TYPE_CONFIG[type];
            const Icon = config.icon;
            const loaded = typeObjects.length;
            const hasActiveFilter = q.trim() || showOrphanedOnly ||
              activeTagIds.length > 0;
            const hasMore = mightHaveMore[type];
            const isCollapsed = collapsed[type];
            const isLoadingMore = loadingTypes.has(type);
            const currentSort = sectionSort[type];
            const showTimeSort = type === "conversation" || type === "event";

            // Sort objects based on section sort option
            const sortedObjects = currentSort === "default"
              ? typeObjects
              : [...typeObjects].sort((a, b) => {
                const aTime = a.timeRanges?.[0]?.start;
                const bTime = b.timeRanges?.[0]?.start;

                if (!aTime && !bTime) return 0;
                if (!aTime) return 1;
                if (!bTime) return -1;

                const aDate = typeof aTime === "string"
                  ? new Date(aTime)
                  : aTime;
                const bDate = typeof bTime === "string"
                  ? new Date(bTime)
                  : bTime;

                return currentSort === "chronological"
                  ? aDate.getTime() - bDate.getTime() // Oldest first
                  : bDate.getTime() - aDate.getTime(); // Newest first
              });

            return (
              <Collapsible
                key={type}
                open={!isCollapsed}
                onOpenChange={() => toggleCollapsed(type)}
              >
                <div
                  ref={getSectionNodeRef(type)}
                  data-object-section={type}
                  className="rounded-lg border bg-muted/30"
                >
                  <div className="flex flex-wrap items-center gap-2 px-3 py-3">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex items-center gap-2 flex-1 hover:bg-muted/50 -m-2 p-2 rounded transition-colors text-left"
                      >
                        {isCollapsed
                          ? (
                            <ChevronRight className="w-5 h-5 text-muted-foreground" />
                          )
                          : (
                            <ChevronDown className="w-5 h-5 text-muted-foreground" />
                          )}
                        <Icon className="w-5 h-5 text-muted-foreground" />
                        <h2 className="text-lg font-semibold">
                          {config.label}
                        </h2>
                        <Badge variant="outline" className="font-semibold">
                          {hasActiveFilter
                            ? (hasMore ? `${loaded}+` : loaded)
                            : (loaded < totalCounts[type]
                              ? `${loaded} / ${totalCounts[type]}`
                              : totalCounts[type])}
                        </Badge>
                        <div className="flex-1" />
                      </button>
                    </CollapsibleTrigger>

                    {/* Time-based sort toggle for conversations/events */}
                    {showTimeSort && !isCollapsed && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant={currentSort === "chronological-desc"
                            ? "secondary"
                            : "ghost"}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSectionSort((prev) => ({
                              ...prev,
                              [type]: "chronological-desc",
                            }));
                          }}
                          title="Newest first"
                        >
                          <SortDesc className="w-3 h-3 mr-1" />
                          Newest
                        </Button>
                        <Button
                          variant={currentSort === "chronological"
                            ? "secondary"
                            : "ghost"}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSectionSort((prev) => ({
                              ...prev,
                              [type]: "chronological",
                            }));
                          }}
                          title="Oldest first"
                        >
                          <SortAsc className="w-3 h-3 mr-1" />
                          Oldest
                        </Button>
                      </div>
                    )}
                  </div>

                  <CollapsibleContent>
                    <div className="p-3 pt-0 min-h-16">
                      {typeErrors[type]
                        ? (
                          <div className="min-h-16 flex flex-col items-center justify-center gap-2 text-sm text-destructive">
                            <span>
                              Could not load {config.label.toLowerCase()}.
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                enqueueTypeFetch(
                                  type,
                                  fetchedTypes.has(type)
                                    ? "refresh"
                                    : "initial",
                                  true,
                                )}
                            >
                              Retry
                            </Button>
                          </div>
                        )
                        : typeObjects.length === 0 && isLoadingMore
                        ? (
                          <p className="min-h-16 flex items-center justify-center text-sm text-muted-foreground">
                            Loading {config.label.toLowerCase()}...
                          </p>
                        )
                        : typeObjects.length === 0 && fetchedTypes.has(type)
                        ? (
                          <div className="min-h-16 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                            <span>
                              {hasMore
                                ? `No ${config.label.toLowerCase()} in the current candidate page`
                                : `No ${config.label.toLowerCase()} found`}
                            </span>
                            {hasMore && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => loadMore(type)}
                                disabled={isLoadingMore}
                              >
                                Continue searching
                              </Button>
                            )}
                          </div>
                        )
                        : typeObjects.length === 0
                        ? (
                          <p className="min-h-16 flex items-center justify-center text-sm text-muted-foreground">
                            Scroll to load {config.label.toLowerCase()}
                          </p>
                        )
                        : (
                          <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                              {sortedObjects.map((object) => (
                                <ObjectCard
                                  key={object._id.toString()}
                                  object={object}
                                  searchQuery={q}
                                  showType
                                  onToggleStar={toggleStar}
                                />
                              ))}
                            </div>

                            {hasMore && (
                              <div className="mt-3 flex items-center justify-center">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => loadMore(type)}
                                  disabled={isLoadingMore}
                                >
                                  {isLoadingMore ? "Loading..." : `Load more`}
                                </Button>
                              </div>
                            )}
                          </>
                        )}
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ObjectsPage;
