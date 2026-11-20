// Run inside the backend container. See DEVELOPMENT.md for preview and apply.
import { type ClientSession, type Db, type Document, ObjectId } from "mongodb";
import { closeRootDB, getRootDB } from "@/lib/mongo/core.server.ts";
import { isSubtitleCreditArtifact } from "@/lib/transcription-filters.ts";
import {
  buildSummarySourceRefs,
  isSingleBriefUtterance,
  selectSummaryUtterances,
} from "#/workers/summarization.ts";

const repair = "subtitle-credit-boundary-v1";
type Transcript = Parameters<typeof selectSummaryUtterances>[0][number];

const transcriptProjection = {
  start: 1,
  end: 1,
  text: 1,
  "segments.text": 1,
  "segments.start": 1,
  "segments.end": 1,
};

export function classifyEvidence(
  transcripts: Transcript[],
  start: Date,
  end: Date,
) {
  const retained = selectSummaryUtterances(transcripts, start, end);
  const credits = transcripts.filter((doc) => {
    const texts = doc.segments?.length
      ? doc.segments.map((s) => s.text)
      : [doc.text];
    return texts.some((text) => text && isSubtitleCreditArtifact(text));
  });
  const brief = isSingleBriefUtterance(retained);
  return { retained, credits, brief };
}

type Assessment = {
  status: string;
  plan?: { name: string; start: Date; end: Date; summary: Document };
};

async function assess(
  db: Db,
  obj: Document,
  session?: ClientSession,
): Promise<Assessment> {
  const latest = obj.summaries?.at(-1);
  if (obj.summaries?.some((entry: Document) => entry.repair === repair)) {
    return { status: "already_repaired" };
  }
  const range = obj.timeRanges?.[0];
  const start = new Date(range?.start);
  const end = new Date(range?.end);
  const refs = latest?.sourceRefs;
  const ids: unknown = refs?.transcriptionIds;
  if (
    obj.timeRanges?.length !== 1 || !(start < end) || !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== "string" || !ObjectId.isValid(id)) ||
    refs?.coverageStart !== start.toISOString() ||
    refs?.coverageEnd !== end.toISOString()
  ) {
    return { status: "missing_or_changed_source_receipt" };
  }
  const transcripts = await db.collection<Transcript & { _id: ObjectId }>(
    "transcriptions",
  )
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, {
      session,
      projection: transcriptProjection,
    }).toArray();
  const receiptIds = new Set(ids);
  if (transcripts.length !== receiptIds.size) {
    return { status: "missing_transcription" };
  }
  const { retained, credits, brief } = classifyEvidence(
    transcripts,
    start,
    end,
  );
  if (!credits.length) {
    return {
      status: !retained.length
        ? "no_text_in_range_review"
        : brief
        ? "brief_utterance_review"
        : "other",
    };
  }
  if (!retained.length) return { status: "credit_without_other_text_review" };
  if (!brief) return { status: "credit_with_other_speech_review" };

  // Only apply the specific old extraction error that both receipts can prove.
  // Short text or a watermark on its own is not proof that the card is wrong.
  const [line] = retained;
  const extracted = obj.metadata?.extractedWith;
  if (
    !extracted || !ObjectId.isValid(extracted.jobId ?? "") ||
    refs.conversationId !== String(obj._id) ||
    refs.extractorJobId !== extracted.jobId ||
    !refs.conversationChunkIds?.includes(extracted.chunkId) ||
    !Number.isSafeInteger(obj.version) || !latest.jobId ||
    obj._summarizationClaim ||
    obj.summaries.some((s: Document) => s.starred) ||
    line.start !== +start || line.end >= +end ||
    !credits.some((doc) => +new Date(doc.start) === +end)
  ) {
    return { status: "credit_with_brief_speech_review" };
  }
  const job = await db.collection("jobs").findOne({
    _id: new ObjectId(extracted.jobId),
  }, {
    session,
    projection: {
      "result.artifacts.chunkId": 1,
      "result.artifacts.segments": 1,
    },
  });
  const artifact = job?.result?.artifacts?.find((a: Document) =>
    a.chunkId === extracted.chunkId
  );
  const boundary = artifact?.segments?.find((s: Document) =>
    s.conversationId === String(obj._id)
  );
  if (
    !boundary?.boundaryResolved || boundary.title !== obj.name ||
    boundary.rawStart !== line.text || boundary.rawEnd !== line.text ||
    +new Date(boundary.resolvedStart) !== +start ||
    +new Date(boundary.resolvedEnd) !== +end
  ) {
    return { status: "credit_with_brief_speech_review" };
  }
  const correctedEnd = new Date(line.end);
  // A later import or a second recording can introduce additional speech that
  // was absent when the original summary ran. Never overwrite that evidence.
  const currentDocs = await db.collection<Transcript & { _id: ObjectId }>(
    "transcriptions",
  )
    .find({ start: { $lt: end }, end: { $gt: start } }, {
      session,
      projection: transcriptProjection,
    }).toArray();
  const current = selectSummaryUtterances(currentDocs, start, end);
  if (
    currentDocs.some((doc) => !receiptIds.has(String(doc._id))) ||
    current.length !== 1 || String(current[0]._id) !== String(line._id) ||
    current[0].text !== line.text || current[0].end !== line.end ||
    current[0].start !== line.start
  ) {
    return { status: "changed_transcripts_review" };
  }
  return {
    status: "repairable",
    plan: {
      name: line.text,
      start,
      end: correctedEnd,
      summary: {
        text: line.text,
        model: "passthrough",
        modelName: "transcript-only",
        promptName: "Transcript correction",
        repair,
        sourceRefs: buildSummarySourceRefs([line], start, correctedEnd, {
          conversationId: String(obj._id),
          conversationChunkIds: [extracted.chunkId],
          extractorJobId: extracted.jobId,
        }),
      },
    },
  };
}

export async function inspectOne(
  db: Db,
  id: ObjectId,
  apply: boolean,
  session?: ClientSession,
) {
  const obj = await db.collection("objects").findOne({
    _id: id,
    isConversation: true,
  }, { session });
  if (!obj) throw new Error("Conversation not found");
  const { status, plan } = await assess(db, obj, session);
  if (!plan) return { objectId: String(id), status };
  const preview = {
    objectId: String(id),
    status,
    oldTitle: obj.name,
    newTitle: plan.name,
    previousRange: obj.timeRanges[0],
    correctedRange: { start: plan.start, end: plan.end },
    transcriptionIds: plan.summary.sourceRefs.transcriptionIds,
  };
  if (!apply) return preview;
  if (!session?.inTransaction()) {
    throw new Error("Repair requires a transaction");
  }
  const date = new Date();
  const summary = { ...plan.summary, date };
  const timeRanges = [{
    ...obj.timeRanges[0],
    start: plan.start,
    end: plan.end,
  }];
  const changes = [
    { field: "name", oldValue: obj.name, newValue: plan.name },
    { field: "timeRanges", oldValue: obj.timeRanges, newValue: timeRanges },
    {
      field: `summaries.${obj.summaries.length}`,
      oldValue: null,
      newValue: summary,
    },
  ];
  const updated = await db.collection("objects").updateOne({
    _id: id,
    version: obj.version,
  }, {
    $set: { name: plan.name, timeRanges, updatedAt: date },
    $push: { summaries: summary } as Document,
    $inc: { version: 1 },
  }, { session });
  if (updated.modifiedCount !== 1) {
    throw new Error("Conversation changed during repair");
  }
  await db.collection("object_history").insertMany(
    changes.map((change) => ({
      ...change,
      objectId: id,
      version: obj.version + 1,
      action: "update",
      timestamp: date,
      userId: repair,
    })),
    { session },
  );
  return { ...preview, status: "repaired" };
}

export function parseArgs(args: string[]) {
  if (args.length === 1 && args[0] === "--scan") {
    return { scan: true, apply: false };
  }
  if (
    args[0] === "--object" && /^[a-f0-9]{24}$/i.test(args[1] ?? "") &&
    (args.length === 2 || (args.length === 3 && args[2] === "--apply"))
  ) {
    return { scan: false, apply: args.length === 3, id: new ObjectId(args[1]) };
  }
  throw new Error(
    "Use --object <id> [--apply] for one conversation or --scan for an archive dry run.",
  );
}

if (import.meta.main) {
  const options = parseArgs(Deno.args);
  const db = await getRootDB();
  try {
    if (options.scan) {
      const counts: Record<string, number> = {};
      const objects = db.collection("objects").find({ isConversation: true }, {
        projection: {
          _summarizationClaim: 1,
          version: 1,
          name: 1,
          timeRanges: 1,
          "metadata.extractedWith": 1,
          "summaries.jobId": 1,
          "summaries.starred": 1,
          "summaries.repair": 1,
          "summaries.sourceRefs": 1,
        },
      }).batchSize(50);
      for await (const obj of objects) {
        const { status } = await assess(db, obj);
        counts[status] = (counts[status] ?? 0) + 1;
        if (
          status === "repairable" || status.endsWith("_review")
        ) {
          console.log(JSON.stringify({ objectId: String(obj._id), status }));
        }
      }
      console.log(JSON.stringify({ dryRun: true, counts }));
    } else {
      const id = options.id!;
      const result = options.apply
        ? await db.client.withSession((session) =>
          session.withTransaction(() => inspectOne(db, id, true, session))
        )
        : await inspectOne(db, id, false);
      console.log(JSON.stringify(result));
    }
  } finally {
    await closeRootDB();
  }
}
