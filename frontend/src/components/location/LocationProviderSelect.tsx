import {
  LOCATION_PROVIDERS,
  locationProviderLabel,
  UNKNOWN_LOCATION_PROVIDER,
} from "@myceliasdk/location-sources.ts";

interface Props {
  provider?: string;
  label: string;
  disabled?: boolean;
  onChange: (provider: string) => void;
}

export function LocationProviderSelect({ provider, label, disabled, onChange }: Props) {
  return (
    <select
      aria-label={label}
      className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50"
      value={provider ?? UNKNOWN_LOCATION_PROVIDER}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value={UNKNOWN_LOCATION_PROVIDER}>{locationProviderLabel()}</option>
      {Object.entries(LOCATION_PROVIDERS).sort(([, a], [, b]) => a.localeCompare(b)).map(([id, title]) => (
        <option key={id} value={id}>{title}</option>
      ))}
      {provider && provider !== UNKNOWN_LOCATION_PROVIDER && !Object.hasOwn(LOCATION_PROVIDERS, provider) && (
        <option value={provider}>{locationProviderLabel(provider)}</option>
      )}
    </select>
  );
}
