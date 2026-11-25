import { useMemorySearch } from "@/modules/search/useMemorySearch";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarX2,
  ChevronDown,
  Filter,
  Loader2,
  Search,
  SlidersHorizontal,
} from "lucide-react";

import { DateRangePicker } from "@/components/DateRangePicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DateRangeValue } from "@/lib/datePicker";
import {
  ragApi,
  ragCanonicalRoute,
  ragErrorMessage,
  type RagSearchMode,
  type RagSearchResponse,
  type RagSearchResult,
  type RagSourceRef,
} from "@/lib/rag";

const SOURCE_KINDS = [
  { value: "transcription", label: "Transcriptions" },
  { value: "message", label: "Messages" },
  { value: "object", label: "Objects" },
  { value: "media_visual_description", label: "Media descriptions" },
];

const MODE_COPY: Record<RagSearchMode, string> = {
  hybrid: "Find matches by meaning and exact words.",
  semantic: "Find related ideas, even when the wording differs.",
  lexical: "Find exact terms and distinctive names.",
};

function displayDate(value?: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : "—";
}

function firstSourceRef(result: RagSearchResult): RagSourceRef | undefined {
  return result.sourceRefs?.find((source) => source.canonicalUri) ??
    result.sourceRefs?.[0];
}

function resultSource(result: RagSearchResult) {
  const source = firstSourceRef(result);
  return {
    kind: result.source?.kind ?? result.kind ?? source?.kind ??
      result.collection ?? source?.collection ?? "source",
    id: result.source?.id ?? result.sourceId ?? source?.sourceId,
    uri: result.source?.uri ?? result.canonicalUri ?? source?.canonicalUri,
    title: result.source?.title ?? result.title,
    occurredAt: result.source?.start ?? result.occurredAt ?? source?.start,
    end: result.source?.end ?? source?.end,
    representation: result.representation ?? source?.representation,
    platform: result.source?.platform ?? source?.platform,
    senderId: result.source?.senderId,
    groupId: result.source?.groupId,
    sourceHash: result.source?.sourceHash,
  };
}

function CanonicalLink({
  uri,
  start,
  end,
}: {
  uri: string;
  start?: string;
  end?: string;
}) {
  const content = (
    <>
      Open source
      <ArrowUpRight className="h-3.5 w-3.5" />
    </>
  );
  const canonicalRoute = ragCanonicalRoute(uri, { start, end });
  if (canonicalRoute) {
    return (
      <Link
        to={canonicalRoute}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {content}
      </Link>
    );
  }
  if (/^https?:\/\//i.test(uri)) {
    return (
      <a
        href={uri}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {content}
      </a>
    );
  }
  return <span className="text-xs text-muted-foreground">{uri}</span>;
}

function ResultCard(
  { result, rank }: { result: RagSearchResult; rank: number },
) {
  const source = resultSource(result);
  const scoreParts = result.scores
    ? Object.entries(result.scores).filter(([, value]) => value != null)
    : [];

  return (
    <Card data-testid="rag-search-result">
      <CardHeader className="gap-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">#{rank}</Badge>
              <Badge variant="outline">{source.kind}</Badge>
              {source.platform && (
                <Badge variant="outline" className="font-normal">
                  {source.platform}
                </Badge>
              )}
              {source.representation && (
                <Badge variant="outline" className="font-normal">
                  {source.representation}
                </Badge>
              )}
            </div>
            <CardTitle
              role="heading"
              aria-level={3}
              className="break-words text-lg leading-snug"
            >
              {source.title || source.id || result.pointId || result.id}
            </CardTitle>
            {source.occurredAt && (
              <CardDescription className="flex flex-wrap gap-x-3 gap-y-1">
                {source.occurredAt && (
                  <span>
                    {displayDate(source.occurredAt)}
                    {source.end ? ` – ${displayDate(source.end)}` : ""}
                  </span>
                )}
              </CardDescription>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="whitespace-pre-wrap break-words text-base leading-relaxed">{result.text}</p>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Result diagnostics</summary>
            <div className="mt-2 flex flex-wrap gap-3">
              <span>Score: {formatScore(result.score)}</span>
              {source.id && <span>source: {source.id}</span>}
              {scoreParts.map(([label, value]) => (
                <span key={label}>
                  {label}:{" "}
                  <span className="font-mono">{formatScore(value!)}</span>
                </span>
              ))}
              {result.generation && <span>generation: {result.generation}
              </span>}
              {result.evidenceId && (
                <span className="font-mono" title={result.evidenceId}>
                  evidence: {result.evidenceId}
                </span>
              )}
              {source.groupId && <span>context: {source.groupId}</span>}
              {source.senderId && (
                <span className="font-mono">sender: {source.senderId}</span>
              )}
              {source.sourceHash && (
                <span className="font-mono" title={source.sourceHash}>
                  source revision: {source.sourceHash.slice(0, 12)}
                </span>
              )}
            </div>
          </details>
          {source.uri && (
            <CanonicalLink
              uri={source.uri}
              start={source.occurredAt}
              end={source.end}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SearchPage() {
  const { form, setField, submit, response, loading, error } =
    useMemorySearch();
  const {
    query,
    mode,
    kinds,
    range,
    limit,
    platforms,
    senderIds,
    sourceCollection,
    sourceId,
    maxPerSource,
  } = form;
  const setQuery = (value: string) => setField("query", value);
  const setMode = (value: RagSearchMode) => setField("mode", value);
  const setRange = (value: DateRangeValue | undefined) =>
    setField("range", value);
  const setLimit = (value: string) => setField("limit", value);
  const setPlatforms = (value: string) => setField("platforms", value);
  const setSenderIds = (value: string) => setField("senderIds", value);
  const setSourceCollection = (value: string) =>
    setField("sourceCollection", value as typeof sourceCollection);
  const setSourceId = (value: string) => setField("sourceId", value);
  const setMaxPerSource = (value: string) => setField("maxPerSource", value);
  const toggleKind = (kind: string, checked: boolean) =>
    setField(
      "kinds",
      checked ? [...kinds, kind] : kinds.filter((value) => value !== kind),
    );

  const activeOptions = [
    ...kinds.map((kind) => SOURCE_KINDS.find((option) => option.value === kind)?.label),
    range && "Date range",
    platforms.trim(),
    senderIds.trim() && "Sender",
    sourceId.trim() && "Source ID",
    limit !== "10" && `Limit ${limit}`,
    maxPerSource !== "2" && `${maxPerSource} per context`,
  ].filter(Boolean);

  const actualMode = response?.mode ?? mode;
  const results = response?.results ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Search className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Smart Search</h1>
        </div>
        <p className="max-w-3xl text-muted-foreground">
          Find messages, recordings, photos, and memories. Open a result to see
          its original source and time context.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 sm:p-5">
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (query.trim()) {
                event.currentTarget.querySelector("details")?.removeAttribute("open");
              }
              submit();
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="rag-query">Question or phrase</Label>
                <Input
                  id="rag-query"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="What did we decide about the migration?"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2 sm:w-44">
                <Label htmlFor="rag-mode">Search mode</Label>
                <Select
                  value={mode}
                  onValueChange={(value) => setMode(value as RagSearchMode)}
                >
                  <SelectTrigger id="rag-mode" aria-label="Search mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hybrid">Hybrid</SelectItem>
                    <SelectItem value="semantic">Semantic</SelectItem>
                    <SelectItem value="lexical">Lexical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={loading}
                >
                  {loading
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Search className="mr-2 h-4 w-4" />}
                  {loading ? "Searching…" : "Search"}
                </Button>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">{MODE_COPY[mode]}</p>
            <details className="group rounded-lg border bg-muted/25">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <SlidersHorizontal className="h-4 w-4 shrink-0" />
                Filters
                {activeOptions.length > 0 && (
                  <span className="truncate font-normal text-muted-foreground">
                    {activeOptions.join(" · ")}
                  </span>
                )}
                <ChevronDown className="ml-auto h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
              </summary>
              <div className="space-y-4 border-t p-3 sm:p-4">
                <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr_8rem]">
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">Source kinds</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {SOURCE_KINDS.map((option) => (
                        <label
                          key={option.value}
                          className="flex cursor-pointer items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={kinds.includes(option.value)}
                            onCheckedChange={(checked) =>
                              toggleKind(option.value, checked === true)}
                            aria-label={option.label}
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      No selection searches every indexed source.
                    </p>
                  </fieldset>

                  <div className="space-y-2">
                    <DateRangePicker
                      value={range}
                      onChange={setRange}
                      label="Date and time range"
                      placeholder="Any date"
                      precision="minute"
                    />
                    {range && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => setRange(undefined)}
                      >
                        <CalendarX2 className="mr-1 h-3.5 w-3.5" />
                        Clear range
                      </Button>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="rag-limit">Result limit</Label>
                    <Select value={limit} onValueChange={setLimit}>
                      <SelectTrigger id="rag-limit" aria-label="Result limit">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[5, 10, 20, 50].map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="rag-platforms">Exact platforms</Label>
                    <Input
                      id="rag-platforms"
                      value={platforms}
                      onChange={(event) => setPlatforms(event.target.value)}
                      placeholder="mycelia, telegram"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Comma-separated canonical message platform IDs.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rag-sender-ids">
                      Exact message sender IDs
                    </Label>
                    <Input
                      id="rag-sender-ids"
                      value={senderIds}
                      onChange={(event) => setSenderIds(event.target.value)}
                      placeholder="Canonical messages.senderId values"
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground">
                      Comma-separated IDs; this is not a voice-profile filter.
                    </p>
                  </div>
                </div>
                <div className="grid gap-4 lg:grid-cols-[11rem_1fr_10rem]">
                  <div className="space-y-2">
                    <Label htmlFor="rag-source-collection">
                      Exact source type
                    </Label>
                    <Select
                      value={sourceCollection}
                      onValueChange={setSourceCollection}
                    >
                      <SelectTrigger
                        id="rag-source-collection"
                        aria-label="Exact source type"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="transcriptions">
                          Transcription
                        </SelectItem>
                        <SelectItem value="messages">Message</SelectItem>
                        <SelectItem value="objects">Object</SelectItem>
                        <SelectItem value="media_visual_descriptions">
                          Media description
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rag-source-id">Exact source ID</Label>
                    <Input
                      id="rag-source-id"
                      value={sourceId}
                      onChange={(event) => setSourceId(event.target.value)}
                      placeholder="Optional MongoDB source ID"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rag-source-cap">Evidence per context</Label>
                    <Select value={maxPerSource} onValueChange={setMaxPerSource}>
                      <SelectTrigger
                        id="rag-source-cap"
                        aria-label="Evidence per context"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 5, 10].map((value) => (
                          <SelectItem key={value} value={String(value)}>
                            {value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Caps neighboring chunks per chat, recording, or source.
                    </p>
                  </div>
                </div>
              </div>
            </details>
          </form>
        </CardContent>
      </Card>

      <section aria-live="polite" aria-busy={loading} className="space-y-4">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Knowledge search is unavailable</p>
              <p className="mt-1 text-muted-foreground">{error}</p>
            </div>
          </div>
        )}

        {response?.degraded && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-400">
                Degraded retrieval
              </p>
              <p className="mt-1 text-muted-foreground">
                {response.warnings?.join(" · ") || response.warning ||
                  `The requested ${mode} search fell back to ${actualMode}.`}
              </p>
            </div>
          </div>
        )}

        {loading && (
          <Card className="p-10 text-center text-muted-foreground">
            <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin" />
            Searching your memories…
          </Card>
        )}

        {!loading && response && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">
                  {results.length} result{results.length === 1 ? "" : "s"}
                </h2>
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="rag-search-summary"
                >
                  {actualMode} retrieval
                  {response.tookMs != null ? ` · ${response.tookMs} ms` : ""}
                  {` · ${response.selection.distinctSources} sources`}
                  {` · ${response.selection.distinctGroups} contexts`}
                </p>
              </div>
              {(response.projectionId || response.projectionFingerprint) && (
                <details className="text-sm">
                  <summary className="cursor-pointer">
                    Search diagnostics
                  </summary>
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    <Badge
                      variant="outline"
                      className="max-w-full font-mono font-normal"
                    >
                      projection{" "}
                      {response.projectionId || response.projectionFingerprint}
                    </Badge>
                    {response.freshness && (
                      <Badge
                        variant={response.freshness.checkpointState === "error"
                          ? "destructive"
                          : response.freshness.paused
                          ? "secondary"
                          : "outline"}
                        title={response.freshness.checkpointAt
                          ? `Checkpoint ${
                            displayDate(response.freshness.checkpointAt)
                          } · ${response.freshness.checkpointState}`
                          : `Checkpoint timestamp unavailable · ${response.freshness.checkpointState}`}
                      >
                        {response.freshness.lifecycleState}
                        {` · checkpoint ${response.freshness.checkpointState}`}
                        {response.freshness.lagSeconds != null
                          ? ` · ${
                            Math.round(response.freshness.lagSeconds)
                          }s lag`
                          : " · lag unknown"}
                      </Badge>
                    )}
                    <Badge
                      variant={response.revalidation.state === "verified"
                        ? "outline"
                        : "destructive"}
                      title={`${response.revalidation.checkedSources} canonical sources checked`}
                    >
                      Mongo {response.revalidation.state}
                      {response.revalidation.staleCandidates > 0
                        ? ` · ${response.revalidation.staleCandidates} stale dropped`
                        : ""}
                      {response.revalidation.filterRefinedCandidates > 0
                        ? ` · ${response.revalidation.filterRefinedCandidates} exact-filter refined`
                        : ""}
                    </Badge>
                  </div>
                </details>
              )}
            </div>

            {results.length === 0
              ? (
                <Card className="p-10 text-center">
                  <Filter className="mx-auto mb-3 h-7 w-7 text-muted-foreground" />
                  <p className="font-medium">No indexed evidence matched</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Try a broader phrase, clear filters, or use hybrid mode.
                  </p>
                </Card>
              )
              : results.map((result, index) => (
                <ResultCard
                  key={`${result.pointId || result.id || "result"}:${index}`}
                  result={result}
                  rank={index + 1}
                />
              ))}
          </div>
        )}

      </section>
    </div>
  );
}
