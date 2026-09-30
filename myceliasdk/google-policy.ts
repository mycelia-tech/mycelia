export type GooglePolicy = {
  externalServices?: { google?: { enabled?: boolean } };
};
type Destination = { baseUrl?: string; model?: string; providerType?: string };

export function isGoogleDestination(destination: Destination): boolean {
  if (destination.providerType === "google-cloud") return true;
  if (/(^|[/.:])(?:google|gemini)(?:[/.-]|$)/i.test(destination.model ?? "")) {
    return true;
  }
  if (!destination.baseUrl) return false;
  const host = new URL(destination.baseUrl).hostname.toLowerCase();
  return ["googleapis.com", "google.com", "googleusercontent.com"].some((
    domain,
  ) => host === domain || host.endsWith(`.${domain}`));
}

export function assertGoogleAccess(
  config: GooglePolicy,
  destination: Destination,
): void {
  if (
    config.externalServices?.google?.enabled !== true &&
    isGoogleDestination(destination)
  ) {
    throw new Error(
      "GOOGLE_SERVICES_DISABLED: Enable Google explicitly in optional Google settings",
    );
  }
}

/** Local/tailnet endpoints are deliberate admin configuration, metadata endpoints are not. */
export function validatePhotoEndpoint(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    !(["http:", "https:"].includes(url.protocol)) || url.username ||
    url.password || url.search || url.hash ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "metadata" || /^169\.254\./.test(host) ||
    host.startsWith("[fe80:") ||
    host.startsWith("[::ffff:") || host === "100.100.100.200"
  ) {
    throw new Error(
      "Invalid photo endpoint: use http(s), without embedded secrets or metadata addresses",
    );
  }
  return url.toString().replace(/\/+$/, "");
}
