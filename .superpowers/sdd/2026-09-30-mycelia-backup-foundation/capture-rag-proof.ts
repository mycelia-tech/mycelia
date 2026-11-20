#!/usr/bin/env -S deno run --allow-net=127.0.0.1 --allow-run

const baseEnv = {
  HOME: "/Users/pk",
  PATH: "/Users/pk/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
};

function closedJson(value: unknown): string {
  return JSON.stringify(value);
}

async function inspect(name: string) {
  const result = await new Deno.Command("/usr/local/bin/docker", {
    args: ["inspect", name],
    clearEnv: true,
    env: baseEnv,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  try {
    if (result.code !== 0 || result.stdout.byteLength > 4 * 1024 * 1024) {
      throw 0;
    }
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
    );
    if (!Array.isArray(parsed) || parsed.length !== 1) throw 0;
    const item = parsed[0];
    return {
      id: item.Id,
      image: item.Config?.Image,
      health: item.State?.Health?.Status ?? null,
      mounts: (item.Mounts ?? []).map((mount: Record<string, unknown>) => ({
        type: mount.Type,
        name: mount.Name ?? null,
        destination: mount.Destination,
      })).sort((a: { destination: unknown }, b: { destination: unknown }) =>
        String(a.destination).localeCompare(String(b.destination))
      ),
      configFiles:
        item.Config?.Labels?.["com.docker.compose.project.config_files"] ??
          null,
      environmentFile:
        item.Config?.Labels?.["com.docker.compose.project.environment_file"] ??
          null,
    };
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw 0;
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) throw 0;
  return JSON.parse(text);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

try {
  const collectionsPayload = await fetchJson(
    "http://127.0.0.1:46333/collections",
  ) as {
    result?: { collections?: Array<{ name?: unknown }> };
  };
  const names = collectionsPayload.result?.collections?.map(({ name }) => {
    if (typeof name !== "string" || !name || name.length > 256) throw 0;
    return name;
  }).sort() ?? [];
  const summaries = [];
  for (const name of names) {
    const payload = await fetchJson(
      `http://127.0.0.1:46333/collections/${encodeURIComponent(name)}`,
    ) as { result?: Record<string, unknown> };
    const result = payload.result;
    if (!result) throw 0;
    summaries.push({
      name,
      status: result.status,
      points: result.points_count,
      indexed: result.indexed_vectors_count,
      vectors: result.vectors_count,
    });
  }
  let ragReachable = false;
  try {
    await fetchJson("http://127.0.0.1:48091/health", 3000);
    ragReachable = true;
  } catch {
    // A closed boolean is enough; raw response/error is intentionally discarded.
  }
  const totals = summaries.reduce(
    (accumulator, item) => ({
      points: accumulator.points +
        (Number.isSafeInteger(item.points) ? Number(item.points) : 0),
      indexed: accumulator.indexed +
        (Number.isSafeInteger(item.indexed) ? Number(item.indexed) : 0),
    }),
    { points: 0, indexed: 0 },
  );
  console.log(closedJson({
    rag: await inspect("mycelia-rag-full-rag-1"),
    qdrant: await inspect("mycelia-rag-full-qdrant-1"),
    collectionCount: summaries.length,
    totalPoints: totals.points,
    totalIndexedVectors: totals.indexed,
    collectionsGreen: summaries.every((item) => item.status === "green"),
    collectionFingerprintSha256: await sha256(closedJson(summaries)),
    ragReachable,
  }));
} catch {
  console.error("RAG_PROOF_FAILED");
  Deno.exit(1);
}
