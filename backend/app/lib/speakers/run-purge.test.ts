import { expect } from "@std/expect";
import {
  assertRunPurgeSnapshotCurrent,
  buildRunPurgeQueries,
  buildRunPurgeSnapshot,
} from "./run-purge.ts";

Deno.test("purge preview and deletion share the exact deletable predicate", () => {
  const queries = buildRunPurgeQueries("run-7");
  expect(queries.deletable).toEqual({
    runId: "run-7",
    lifecycleStatus: { $ne: "active" },
  });
  expect(queries.embeddings).toEqual({
    ...queries.deletable,
    embedding: { $exists: true },
  });
});

Deno.test("purge cannot delete active identity-source membership", () => {
  const { deletable, active } = buildRunPurgeQueries("run-7");
  expect(deletable.lifecycleStatus).toEqual({ $ne: "active" });
  expect(active.lifecycleStatus).toBe("active");
});

Deno.test("failed or superseded run with active segments cannot be purged", () => {
  for (const status of ["failed", "superseded"]) {
    expect(() =>
      buildRunPurgeSnapshot({
        runId: "run-7",
        status,
        documents: 10,
        embeddings: 8,
        activeSegments: 1,
      })
    ).toThrow("still has 1 active");
  }
});

Deno.test("purge rejects document-count drift after preview", () => {
  const preview = buildRunPurgeSnapshot({
    runId: "run-7",
    status: "superseded",
    documents: 10,
    embeddings: 8,
    activeSegments: 0,
  });
  const changed = buildRunPurgeSnapshot({
    runId: "run-7",
    status: "superseded",
    documents: 11,
    embeddings: 8,
    activeSegments: 0,
  });

  expect(() =>
    assertRunPurgeSnapshotCurrent(preview, changed, preview.confirmation)
  ).toThrow("preview purge again");
  expect(() =>
    assertRunPurgeSnapshotCurrent(preview, preview, preview.confirmation)
  ).not.toThrow();
});
