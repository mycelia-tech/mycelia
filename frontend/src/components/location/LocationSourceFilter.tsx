import { useEffect, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  type LocationSourceFilter as SourceFilter,
  locationProviderLabel,
  UNKNOWN_LOCATION_PROVIDER,
} from "@myceliasdk/location-sources.ts";
import { useLocationImportSources, useLocationSourceFiles } from "@/hooks/useLocationQueries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
export function activeSourceFilter(filter: SourceFilter): SourceFilter | undefined {
  if (filter.excludedProviders.length || filter.excludedImportIds.length || filter.excludeManual) {
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
}

export function LocationSourceFilter({ label, filter, onChange, includeManual }: Props) {
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant={exclusions ? "secondary" : "outline"} size="sm"
          className="h-8 bg-background/95 shadow-sm" aria-label={label}>
          <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" />
          {label}
          {exclusions > 0 && <span className="ml-1.5 rounded bg-muted px-1.5">{exclusions}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={label} className="z-[1200] w-[min(22rem,calc(100vw-1rem))] p-3"
        side="top" align="start" collisionPadding={8}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{label}</h3>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" className="h-7 px-2"
              disabled={!exclusions} onClick={() => onChange(ALL_LOCATION_SOURCES)}>
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

        {sources.isLoading && <p className="text-sm text-muted-foreground">Loading sources…</p>}
        {sources.isError && (
          <Button variant="ghost" size="sm" onClick={() => void sources.refetch()}>
            Could not load sources. Retry
          </Button>
        )}
        {sources.data && (
          <div className="max-h-[min(55vh,24rem)] space-y-1 overflow-y-auto">
            {includeManual && (
              <label className="flex items-center gap-2 px-1 py-2 text-sm">
                <Checkbox checked={!filter.excludeManual}
                  onCheckedChange={(checked) => onChange({ ...filter, excludeManual: !checked })} />
                Manual locations
              </label>
            )}
            {groups.map(({ provider: key, count }) => (
              <div key={key}>
                <div className="flex min-h-9 items-center justify-between gap-2 rounded-md px-1 hover:bg-muted/60">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                    <Checkbox checked={!disabledApps.has(key)}
                      onCheckedChange={() => onChange({
                        ...filter, excludedProviders: toggle(filter.excludedProviders, key),
                      })} />
                    <span className="truncate">{locationProviderLabel(key)}</span>
                  </label>
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
                      <label key={String(source._id)} className="flex items-center gap-2 py-1 text-xs">
                        <Checkbox
                          checked={!disabledApps.has(key) && !disabledFiles.has(String(source._id))}
                          disabled={disabledApps.has(key)}
                          onCheckedChange={() => onChange({
                            ...filter, excludedImportIds: toggle(filter.excludedImportIds, String(source._id)),
                          })} />
                        <span className="truncate" title={source.filename}>{source.filename}</span>
                      </label>
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
