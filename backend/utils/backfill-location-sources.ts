import { Buffer } from "node:buffer";
import { GridFSBucket, MongoClient, ObjectId } from "mongodb";
import type { LocationOrigin } from "@myceliasdk/location-sources.ts";
import { originFromExporter } from "@/lib/location/sources.server.ts";

const apply = Deno.args.includes("--apply");
if (Deno.args.some((argument) => argument !== "--apply")) {
  throw new Error(
    "Usage: deno run -A utils/backfill-location-sources.ts [--apply]",
  );
}

const uri = Deno.env.get("MONGO_URL");
const databaseName = Deno.env.get("DATABASE_NAME");
if (!uri || !databaseName) {
  throw new Error("MONGO_URL and DATABASE_NAME are required");
}
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });

try {
  const db = client.db(databaseName);
  const imports = db.collection("location_imports");
  const originals = new GridFSBucket(db, { bucketName: "location_files" });
  const syncDays = await db.collection("location_sync_days").find(
    { sourceId: /^reitti:/ },
    { projection: { day: 1, hash: 1 } },
  ).toArray();
  const syncHashes = new Set(syncDays.map(({ day, hash }) => `${day}:${hash}`));
  const counts = new Map<string, number>();
  let updated = 0;
  let unreadable = 0;

  for await (
    const file of imports.find({
      committedAt: { $type: "date" },
      origin: { $exists: false },
    }, {
      projection: {
        filename: 1,
        format: 1,
        fileId: 1,
        fileSize: 1,
        contentHash: 1,
        "datasetMetadata.rawMetadata.@_creator": 1,
      },
    })
  ) {
    let origin: LocationOrigin | undefined;
    const day = /^reitti-device-.+-(\d{4}-\d{2}-\d{2})\.gpx$/i.exec(
      file.filename,
    )?.[1];
    if (day && syncHashes.has(`${day}:${file.contentHash}`)) {
      origin = { provider: "reitti", evidence: "connector" };
    } else if (file.format === "gpx") {
      origin = originFromExporter(
        file.datasetMetadata?.rawMetadata?.["@_creator"],
      );
      if (!origin && file.fileId) {
        try {
          const id = new ObjectId(String(file.fileId));
          const size = file.fileSize ??
            (await originals.find({ _id: id }).next())?.length;
          if (!size) throw new Error("Original is unavailable");
          const stream = originals.openDownloadStream(id, {
            end: Math.min(16_384, Number(size)),
          });
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream) chunks.push(chunk);
          const header = new TextDecoder().decode(Buffer.concat(chunks));
          const root = /<gpx\b[^>]*\bcreator\s*=\s*(["'])(.*?)\1/si.exec(
            header,
          );
          origin = originFromExporter(root?.[2]);
        } catch {
          unreadable++;
        }
      }
    }

    const provider = origin?.provider ?? "unknown";
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
    if (apply && origin) {
      const result = await imports.updateOne({
        _id: file._id,
        committedAt: { $type: "date" },
        origin: { $exists: false },
      }, { $set: { origin } });
      updated += result.modifiedCount;
    }
  }
  console.log(JSON.stringify(
    {
      mode: apply ? "apply" : "preview",
      candidates: Object.fromEntries(counts),
      updated,
      unreadable,
    },
    null,
    2,
  ));
} finally {
  await client.close();
}
