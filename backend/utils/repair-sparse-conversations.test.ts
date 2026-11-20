import { expect } from "@std/expect";
import { type ClientSession, type Db, type Document, ObjectId } from "mongodb";
import {
  classifyEvidence,
  inspectOne,
  parseArgs,
} from "./repair-sparse-conversations.ts";

Deno.test("archive scan is read-only and apply requires exactly one valid object id", () => {
  const id = "65b000000000000000000000";
  expect(parseArgs(["--scan"])).toEqual({ scan: true, apply: false });
  expect(parseArgs(["--object", id]).apply).toBe(false);
  expect(parseArgs(["--object", id, "--apply"])).toEqual({
    scan: false,
    apply: true,
    id: new ObjectId(id),
  });
  for (
    const args of [
      [],
      ["--apply"],
      ["--scan", "--apply"],
      ["--apply", "--scan"],
      ["--object", "invalid"],
      ["--object", id, "--scan"],
      ["--object", id, "--apply", id],
    ]
  ) expect(() => parseArgs(args)).toThrow();
});

const time = (seconds: number) =>
  new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

Deno.test("only the overlapping short utterance survives a credit at the right boundary", () => {
  const speech = {
    start: time(0),
    end: time(12),
    segments: [{ start: 10, end: 12, text: "Что?" }],
  };
  const neighbor = {
    start: time(40),
    end: time(60),
    text: "Субтитры делал DimaTorzok",
  };
  const evidence = classifyEvidence([neighbor, speech], time(0), time(40));
  expect(evidence.credits).toEqual([neighbor]);
  expect(evidence.retained.map((line) => [line.text, line.start, line.end]))
    .toEqual([
      ["Что?", +time(10), +time(12)],
    ]);
  expect(evidence.brief).toBe(true);
  expect(classifyEvidence([neighbor], time(0), time(40)).brief).toBe(false);
});

function fixture() {
  const id = new ObjectId();
  const jobId = String(new ObjectId());
  const chunkId = String(new ObjectId());
  const start = time(0), end = time(40);
  const speech = { _id: new ObjectId(), start, end: time(12), text: "Что?" };
  const credit = {
    _id: new ObjectId(),
    start: end,
    end: time(50),
    text: "Субтитры сделал DimaTorzok.",
  };
  const receipt = {
    coverageStart: start.toISOString(),
    coverageEnd: end.toISOString(),
    transcriptionIds: [String(speech._id), String(credit._id)],
    conversationId: String(id),
    conversationChunkIds: [chunkId],
    extractorJobId: jobId,
  };
  const obj: Document = {
    _id: id,
    version: 2,
    isConversation: true,
    name: "Old title",
    timeRanges: [{ start, end }],
    metadata: { extractedWith: { jobId, chunkId } },
    summaries: [{ jobId: String(new ObjectId()), sourceRefs: receipt }],
  };
  const boundary = {
    conversationId: String(id),
    title: obj.name,
    boundaryResolved: true,
    rawStart: speech.text,
    rawEnd: speech.text,
    resolvedStart: start,
    resolvedEnd: end,
  };
  const current = [speech];
  let versionAtWrite = obj.version;
  const history: Document[] = [];
  const db = {
    collection(name: string) {
      switch (name) {
        case "objects":
          return {
            findOne: () => obj,
            updateOne: (query: Document, update: Document) => {
              expect(query._id).toEqual(id);
              if (query.version !== versionAtWrite) return { modifiedCount: 0 };
              obj.summaries.push(update.$push.summaries);
              Object.assign(obj, update.$set);
              obj.version += update.$inc.version;
              return { modifiedCount: 1 };
            },
          };
        case "transcriptions":
          return {
            find: (query: Document) => ({
              toArray: () => query._id ? [speech, credit] : current,
            }),
          };
        case "jobs":
          return {
            findOne: () => ({
              result: { artifacts: [{ chunkId, segments: [boundary] }] },
            }),
          };
        case "object_history":
          return {
            insertMany: (changes: Document[]) => history.push(...changes),
          };
        default:
          throw new Error(`Unexpected collection: ${name}`);
      }
    },
  } as unknown as Db;
  const session = { inTransaction: () => true } as ClientSession;
  return {
    id,
    obj,
    db,
    history,
    current,
    session,
    simulateConcurrentEdit: () => versionAtWrite++,
  };
}

Deno.test("preview, concurrent edit and repeat apply preserve conversation history", async () => {
  const f = fixture();
  expect((await inspectOne(f.db, f.id, false)).status).toBe("repairable");
  expect(f.obj.summaries).toHaveLength(1);
  expect(f.history).toEqual([]);
  await expect(inspectOne(f.db, f.id, true)).rejects.toThrow("transaction");

  const raced = fixture();
  raced.simulateConcurrentEdit();
  await expect(inspectOne(raced.db, raced.id, true, raced.session)).rejects
    .toThrow("changed");
  expect(raced.history).toEqual([]);
  expect(raced.obj.summaries).toHaveLength(1);

  const original = f.obj.summaries[0];
  expect((await inspectOne(f.db, f.id, true, f.session)).status).toBe(
    "repaired",
  );
  expect(f.obj.summaries[0]).toBe(original);
  expect(f.obj.summaries).toHaveLength(2);
  expect(f.history.map((row) => row.field)).toContain("summaries.1");
  const historyLength = f.history.length;
  f.obj.summaries.push({ text: "A later manual summary" });
  expect((await inspectOne(f.db, f.id, true, f.session)).status).toBe(
    "already_repaired",
  );
  expect(f.history.length).toBe(historyLength);
  expect(f.obj.summaries).toHaveLength(3);
});

Deno.test("a changed title, starred summary, or additional intervening speech makes the repair review-only", async () => {
  const f = fixture();
  f.obj.name = "Edited title";
  expect((await inspectOne(f.db, f.id, false)).status).toBe(
    "credit_with_brief_speech_review",
  );
  f.obj.name = "Old title";
  f.obj.summaries[0].starred = true;
  expect((await inspectOne(f.db, f.id, false)).status).toBe(
    "credit_with_brief_speech_review",
  );
  f.obj.summaries[0].starred = false;
  f.current.push({
    _id: new ObjectId(),
    start: time(25),
    end: time(29),
    text: "Новая реплика",
  });
  expect((await inspectOne(f.db, f.id, true, f.session)).status).toBe(
    "changed_transcripts_review",
  );
  expect(f.obj.summaries).toHaveLength(1);
  expect(f.history).toEqual([]);
});

Deno.test("a later untimed import spanning the boundary needs review", async () => {
  const f = fixture();
  f.current.push({
    _id: new ObjectId(),
    start: time(35),
    end: time(90),
    text: "Later import",
  });
  expect((await inspectOne(f.db, f.id, false)).status).toBe(
    "changed_transcripts_review",
  );
});
