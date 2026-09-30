import { expect } from "@std/expect";
import {
  assertCanRunWorkerFromJobs,
  assertCanUseGenericQueueAction,
  canRunWorkerFromJobs,
  canUseGenericQueueAction,
  DOMAIN_MANAGED_MEDIA_JOB_TYPES,
  globalQueueClearJobsQuery,
  jobTypesForGlobalQueueClear,
  manualJobSchemas,
} from "./job-action-policy.ts";

Deno.test("global queue clear leaves domain media campaigns untouched", () => {
  expect(jobTypesForGlobalQueueClear([
    "transcription",
    "mediaFolderImport",
    "mediaRecognitionBatch",
    "mediaRecognition",
    "summarization",
  ])).toEqual(["transcription", "summarization"]);
  expect(globalQueueClearJobsQuery()).toEqual({
    type: { $nin: [...DOMAIN_MANAGED_MEDIA_JOB_TYPES] },
    state: { $in: ["waiting", "delayed"] },
  });
});

Deno.test("generic cancel and clear reject domain media before side effects", () => {
  for (const workerType of DOMAIN_MANAGED_MEDIA_JOB_TYPES) {
    expect(canUseGenericQueueAction(workerType)).toBe(false);
    expect(() => assertCanUseGenericQueueAction(workerType)).toThrow(
      "domain-managed media campaign",
    );
  }
  expect(canUseGenericQueueAction("transcription")).toBe(true);
  expect(() => assertCanUseGenericQueueAction("transcription")).not.toThrow();
});

Deno.test("generic manual actions use catalog manualRun as an allow-list", () => {
  expect(canRunWorkerFromJobs("transcription")).toBe(true);
  expect(canRunWorkerFromJobs("ingestion")).toBe(true);
  expect(canRunWorkerFromJobs("mediaFolderImport")).toBe(false);
  expect(canRunWorkerFromJobs("mediaRecognitionBatch")).toBe(false);
  expect(canRunWorkerFromJobs("mediaRecognition")).toBe(false);
  expect(canRunWorkerFromJobs("unknownInternalWorker")).toBe(false);

  expect(() => assertCanRunWorkerFromJobs("mediaRecognitionBatch")).toThrow(
    "managed outside Jobs",
  );
});

Deno.test("manual job schemas exclude domain and internal workers", () => {
  expect(manualJobSchemas({
    transcription: { input: "manual" },
    mediaFolderImport: { input: "domain" },
    mediaRecognitionBatch: { input: "domain" },
    mediaRecognition: { input: "internal" },
  })).toEqual({
    transcription: { input: "manual" },
  });
});
