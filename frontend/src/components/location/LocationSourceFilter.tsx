import { useEffect, useId, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, LocateFixed, SlidersHorizontal, X } from "lucide-react";
import {
  type LocationSourceFilter as SourceFilter,
  locationProviderLabel,
  UNKNOWN_LOCATION_PROVIDER,
} from "@myceliasdk/location-sources.ts";
import { useLocationImportSources, useLocationSourceFiles } from "@/hooks/useLocationQueries";
import type { MapSourceSelection } from "@/types/location";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function activeSourceFilter(filter: SourceFilter): SourceFilter | undefined {
  if (filter.onlyProvider || filter.onlyImportId || filter.excludedProviders.length ||
    filter.excludedImportIds.length || filter.excludeManual) {
    return filter;
  }
}

export const ALL_LOCATION_SOURCES: SourceFilter = {
  excludedProviders: [],
  excludedImportIds: [],
};

function toggle(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value].sort();
}

interface Props {
  label: string;
  filter: SourceFilter;
  onChange: (filter: SourceFilter) => void;
  includeManual?: boolean;
  onShowOnMap?: (source: MapSourceSelection) => void;
  focus?: MapSourceSelection;
}

export function LocationSourceFilter({ label, filter, onChange, includeManual, onShowOnMap, focus }: Props) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const sources = useLocationImportSources(open);
  const [provider, setProvider] = useState<string>();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const files = useLocationSourceFiles(provider, debouncedSearch, page, open);
  const groups = useMemo(() => {
    const entries = [...(sources.data ?? [])];
    if (!entries.some((source) => source.provider === UNKNOWN_LOCATION_PROVIDER)) {
      entries.push({ provider: UNKNOWN_LOCATION_PROVIDER, count: 0 });
    }
    return entries.sort((a, b) =>
      locationProviderLabel(a.provider).localeCompare(locationProviderLabel(b.provider))
    );
  }, [sources.data]);
  const disabledApps = new Set(filter.excludedProviders);
  const disabledFiles = new Set(filter.excludedImportIds);
  const exclusions = filter.excludedProviders.length + filter.excludedImportIds.length +
    (filter.excludeManual ? 1 : 0);
  const focusName = filter.onlyImportId
    ? (focus?.importId === filter.onlyImportId ? focus.label : "1 file")
    : filter.onlyProvider && locationProviderLabel(filter.onlyProvider);

  function sourceName(source: MapSourceSelection, checkboxId: string) {
    if (!onShowOnMap) {
      return (
        <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer truncate" title={source.label}>
          {source.label}
        </label>
      );
    }
    const selected = source.importId
      ? filter.onlyImportId === source.importId
      : filter.onlyProvider === source.provider;
    return (
      <button
        type="button"
        className="group flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded px-1 text-left hover:text-primary focus-visible:outline-ring"
        aria-label={`Show ${source.label} on map`}
        aria-pressed={selected}
        title={`Show ${source.label} on map`}
        onClick={() => {
          onShowOnMap(source);
          setOpen(false);
        }}
      >
        <span className="truncate group-hover:underline">{source.label}</span>
        {selected
          ? <Check aria-hidden className="size-3.5 shrink-0 text-primary" />
          : <LocateFixed aria-hidden className="size-3.5 shrink-0 text-muted-foreground group-hover:text-primary" />}
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="inline-flex min-w-0 max-w-full items-center gap-0.5">
        <PopoverTrigger asChild>
          <Button type="button" variant={focusName || exclusions ? "secondary" : "outline"} size="sm"
            className="h-8 min-w-0 max-w-full" aria-label={label} title={focusName}>
            <SlidersHorizontal className="size-3.5 shrink-0" />
            {label}
            {focusName
              ? <span className="max-w-28 truncate">{focusName}</span>
              : exclusions > 0 && <span className="rounded bg-muted px-1.5">{exclusions} hidden</span>}
          </Button>
        </PopoverTrigger>
        {focusName && (
          <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0"
            title={`Clear ${label.toLowerCase()} focus`} aria-label={`Clear ${label.toLowerCase()} focus`}
            onClick={() => onChange(ALL_LOCATION_SOURCES)}>
            <X aria-hidden className="size-3.5" />
          </Button>
        )}
      </div>
      <PopoverContent aria-label={label} className="z-[1200] w-[min(23rem,calc(100vw-1rem))] p-3"
        side="top" align="start" collisionPadding={8}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{label}</h3>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2"
              disabled={!exclusions && !focusName} onClick={() => onChange(ALL_LOCATION_SOURCES)}>
              Show all
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2"
              disabled={!sources.data}
              onClick={() => onChange({
                excludedProviders: groups.map((source) => source.provider).sort(),
                excludedImportIds: [],
                ...(includeManual ? { excludeManual: true } : {}),
              })}>
              Hide all
            </Button>
          </div>
        </div>

        {onShowOnMap && (
          <p className="mb-2 text-xs text-muted-foreground">
            {focusName
              ? `Showing only ${focusName}. Choose Show all to combine sources again.`
              : "Check sources to combine them, or select a name to view it on the map."}
          </p>
        )}
        {sources.isLoading && <p className="text-sm text-muted-foreground">Loading sources…</p>}
        {sources.isError && (
          <Button variant="ghost" size="sm" onClick={() => void sources.refetch()}>
            Could not load sources. Retry
          </Button>
        )}
        {sources.data && (
          <div className="max-h-[min(55vh,24rem)] space-y-1 overflow-y-auto">
            {includeManual && !focusName && (
              <label className="flex items-center gap-2 px-1 py-2 text-sm">
                <Checkbox checked={!filter.excludeManual}
                  onCheckedChange={(checked) => onChange({ ...filter, excludeManual: !checked })} />
                Manual locations
              </label>
            )}
            {groups.map(({ provider: key, count }) => (
              <div key={key}>
                <div className="flex min-h-9 items-center gap-2 rounded-md px-1 text-sm hover:bg-muted/60">
                  {!focusName && <Checkbox id={`${fieldId}-${key}`} aria-label={`Show ${locationProviderLabel(key)}`}
                    checked={!disabledApps.has(key)}
                    onCheckedChange={() => onChange({
                      ...filter, excludedProviders: toggle(filter.excludedProviders, key),
                    })} />}
                  {sourceName({ provider: key, label: locationProviderLabel(key) }, `${fieldId}-${key}`)}
                  {count > 0 && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs tabular-nums"
                      aria-label={`Browse ${locationProviderLabel(key)} files`}
                      aria-expanded={provider === key}
                      onClick={() => {
                        setProvider(provider === key ? undefined : key);
                        setSearch("");
                        setDebouncedSearch("");
                        setPage(0);
                      }}>
                      {count} {count === 1 ? "file" : "files"}
                      {provider === key
                        ? <ChevronDown aria-hidden className="ml-1 size-3.5" />
                        : <ChevronRight aria-hidden className="ml-1 size-3.5" />}
                    </Button>
                  )}
                </div>
                {provider === key && (
                  <div className="ml-3 space-y-1 border-l pl-3 pb-2">
                    {count > 5 && (
                      <Input aria-label="Find source files" placeholder="Find files…" value={search}
                        className="mb-1 h-8"
                        onChange={(event) => setSearch(event.target.value)} />
                    )}
                    {files.isLoading && <p className="text-xs text-muted-foreground">Loading files…</p>}
                    {files.isError && (
                      <Button variant="ghost" size="sm" onClick={() => void files.refetch()}>
                        Could not load files. Retry
                      </Button>
                    )}
                    {(files.data?.files ?? []).map((source) => (
                      <div key={String(source._id)} className="flex min-h-8 items-center gap-2 text-xs">
                        {!focusName && <Checkbox id={`${fieldId}-${source._id}`} aria-label={`Show ${source.filename}`}
                          checked={!disabledApps.has(key) && !disabledFiles.has(String(source._id))}
                          disabled={disabledApps.has(key)}
                          onCheckedChange={() => onChange({
                            ...filter, excludedImportIds: toggle(filter.excludedImportIds, String(source._id)),
                          })} />}
                        {sourceName({ provider: key, importId: String(source._id), label: source.filename }, `${fieldId}-${source._id}`)}
                      </div>
                    ))}
                    {files.data?.files.length === 0 && (
                      <p className="py-1 text-xs text-muted-foreground">No matching files.</p>
                    )}
                    {(page > 0 || files.data?.hasMore) && (
                      <div className="flex justify-between gap-2 pt-1">
                        <Button variant="ghost" size="sm" className="h-7 text-xs"
                          disabled={page === 0} onClick={() => setPage((current) => current - 1)}>
                          Previous files
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs"
                          disabled={!files.data?.hasMore} onClick={() => setPage((current) => current + 1)}>
                          Next files
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
