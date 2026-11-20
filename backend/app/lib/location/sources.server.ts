import type { Db, Document } from "mongodb";
import { ObjectId } from "bson";
import { z } from "zod";
import {
  type LocationOrigin,
  type LocationSourceFilter,
  UNKNOWN_LOCATION_PROVIDER,
} from "@myceliasdk/location-sources.ts";

export const locationProviderSchema = z.string().regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
).max(64);

export const locationSourceFilterSchema = z.object({
  excludedProviders: z.array(locationProviderSchema).max(100),
  excludedImportIds: z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(5000),
  excludeManual: z.boolean().optional(),
});

const EXPORTERS: ReadonlyArray<[RegExp, string]> = [
  [/^reitti(?:$|[\s/.-])|^https?:\/\/(?:www\.)?reitti\.com(?:\/|$)/i, "reitti"],
  [
    /^organic maps(?:$|[\s/])|^https?:\/\/organicmaps\.app(?:\/|$)/i,
    "organic-maps",
  ],
  [/^comaps(?:$|[\s/])|^https?:\/\/(?:www\.)?comaps\.app(?:\/|$)/i, "comaps"],
  [/^osmand(?:$|[\s/])|^https?:\/\/osmand\.net(?:\/|$)/i, "osmand"],
  [/^maps\.me(?:$|[\s/])/i, "maps-me"],
];

export function originFromExporter(
  creator: unknown,
): LocationOrigin | undefined {
  if (typeof creator !== "string") return;
  const match = EXPORTERS.find(([pattern]) => pattern.test(creator.trim()));
  if (match) return { provider: match[1], evidence: "exporter" };
}

export function importProviderQuery(provider: string): Document {
  return provider === UNKNOWN_LOCATION_PROVIDER
    ? { "origin.provider": { $in: [null, UNKNOWN_LOCATION_PROVIDER] } }
    : { "origin.provider": provider };
}

/** Match an entity once when any committed contributing file is enabled. */
export async function locationSourceQuery(
  db: Db,
  filter: LocationSourceFilter | undefined,
  linkField: "importIds" | "sourceRefs.importId",
  includeManual = false,
): Promise<Document> {
  if (!filter) return {};
  const { excludedProviders, excludedImportIds, excludeManual } = filter;
  const manual = includeManual && excludeManual
    ? { type: { $ne: "manual" } }
    : {};
  if (excludedProviders.length === 0 && excludedImportIds.length === 0) {
    return manual;
  }

  const excludedIds = excludedImportIds.map((id) => new ObjectId(id));
  const includeUnknown = !excludedProviders.includes(UNKNOWN_LOCATION_PROVIDER);
  const providerList = excludedProviders.filter((provider) =>
    provider !== UNKNOWN_LOCATION_PROVIDER
  );
  const committed = { committedAt: { $type: "date" } } as const;
  const collection = db.collection("location_imports");
  const refs = (ids: ObjectId[]) => ids.flatMap((id) => [id, String(id)]);
  let linked: Document;
  if (includeUnknown) {
    const excluded = providerList.length
      ? await collection.find(
        { ...committed, "origin.provider": { $in: providerList } },
        { projection: { _id: 1 }, maxTimeMS: 3000 },
      ).toArray()
      : [];
    const disabled = refs([
      ...excludedIds,
      ...excluded.map((file) => file._id),
    ]);
    const available = { $nin: disabled };
    linked = {
      $or: [
        { [linkField]: { $exists: false } },
        ...(linkField === "importIds" ? [{ importIds: { $size: 0 } }] : []),
        linkField === "importIds"
          ? { importIds: { $elemMatch: available } }
          : { sourceRefs: { $elemMatch: { importId: available } } },
      ],
    };
  } else {
    const enabled = await collection.find(
      {
        ...committed,
        _id: { $nin: excludedIds },
        "origin.provider": {
          $exists: true,
          $nin: [null, ...excludedProviders],
        },
      },
      { projection: { _id: 1 }, maxTimeMS: 3000 },
    ).toArray();
    linked = { [linkField]: { $in: refs(enabled.map((file) => file._id)) } };
  }
  if (!includeManual) return linked;
  return {
    $or: [
      { type: { $ne: "manual" }, ...linked },
      ...(!excludeManual ? [{ type: "manual" }] : []),
    ],
  };
}
