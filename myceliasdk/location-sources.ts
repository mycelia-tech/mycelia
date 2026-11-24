export const LOCATION_PROVIDERS: Readonly<Record<string, string>> = {
  reitti: "Reitti",
  "organic-maps": "Organic Maps",
  comaps: "CoMaps",
  "google-maps": "Google Maps",
  osmand: "OsmAnd",
  "maps-me": "MAPS.ME",
};

export const UNKNOWN_LOCATION_PROVIDER = "unknown";

export interface LocationOrigin {
  provider: string;
  evidence: "connector" | "exporter" | "confirmed";
}

export interface LocationSourceFilter {
  excludedProviders: string[];
  excludedImportIds: string[];
  excludeManual?: boolean;
  onlyProvider?: string;
  onlyImportId?: string;
}

export function locationProviderLabel(provider?: string): string {
  if (!provider || provider === UNKNOWN_LOCATION_PROVIDER) {
    return "Unknown application";
  }
  return Object.hasOwn(LOCATION_PROVIDERS, provider)
    ? LOCATION_PROVIDERS[provider]
    : provider;
}
