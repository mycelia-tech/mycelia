import { expect } from "@std/expect";
import {
  assertProfileArchiveSnapshotCurrent,
  buildProfileArchiveSnapshot,
  buildProfileArchiveUpdate,
  buildProfileRestoreUpdate,
} from "./profile-lifecycle.ts";

const baseInput = {
  profile: {
    id: "698349a50dadb6125cb83312",
    name: "Sky",
    revision: 6,
    isPrimary: false,
    lifecycleStatus: "active" as const,
  },
  references: {
    samples: 5,
    annotations: 317,
    calibrations: 4,
    identityDecisions: 32_853,
  },
};

Deno.test("profile archive preserves references and binds confirmation to preview", () => {
  const preview = buildProfileArchiveSnapshot(baseInput);
  expect(preview.archivable).toBe(true);
  expect(preview.retainedReferences).toBe(33_179);
  expect(preview.preserves).toContain("manual annotations");
  expect(() =>
    assertProfileArchiveSnapshotCurrent(
      preview,
      preview,
      preview.confirmation!,
    )
  ).not.toThrow();

  const changed = buildProfileArchiveSnapshot({
    ...baseInput,
    references: { ...baseInput.references, annotations: 318 },
  });
  expect(() =>
    assertProfileArchiveSnapshotCurrent(
      preview,
      changed,
      preview.confirmation!,
    )
  ).toThrow("preview archive again");
});

Deno.test("primary and in-use profiles cannot be archived", () => {
  const preview = buildProfileArchiveSnapshot({
    ...baseInput,
    profile: { ...baseInput.profile, isPrimary: true },
    references: {
      ...baseInput.references,
      activeCampaigns: 1,
      activeModelSets: 1,
    },
  });

  expect(preview.archivable).toBe(false);
  expect(preview.blockers).toEqual([
    "replacement_primary_required",
    "active_campaign",
    "active_model_set",
  ]);
});

Deno.test("archive and restore are tombstone updates and restore is non-primary", () => {
  const archivedAt = new Date("2026-10-10T09:00:00Z");
  const archive = buildProfileArchiveUpdate({
    archivedAt,
    archivedBy: "operator",
    snapshotFingerprint: "snapshot",
  });
  const restore = buildProfileRestoreUpdate({
    restoredAt: archivedAt,
    restoredBy: "operator",
  });

  expect(archive.$set).toMatchObject({
    lifecycleStatus: "archived",
    is_primary: false,
  });
  expect(archive).not.toHaveProperty("$unset.embedding");
  expect(restore.$set).toMatchObject({
    lifecycleStatus: "active",
    is_primary: false,
  });
});
