// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildSummaryHistoryPipeline,
  buildSummaryTaskPipeline,
  normalizeSummaryHistoryResult,
  normalizeSummaryTaskResult,
  summaryPreview,
} from "./summaryHistory";

describe("summary history aggregation", () => {
  it("previews summary prose without participant lists or markdown markers", () => {
    expect(
      summaryPreview(
        "## Participants\n- Alex\n## Summary\nA **decision** about [the project](https://example.com).\n## Actions\nCall tomorrow.",
      ),
    )
      .toBe("A decision about the project.");
    expect(summaryPreview("Plain summary.")).toBe("Plain summary.");
  });
  it("intersects period and amount before counting unique conversations or selecting reruns", () => {
    const pipeline = buildSummaryHistoryPipeline({
      start: "2026-08-24T00:00:00Z",
      end: "2026-08-31T00:00:00Z",
      amount: 250,
      limit: 100,
    });
    const facet = pipeline[2].$facet as any;
    for (
      const stages of [facet.total, facet.objectCount, facet.selectedObjects]
    ) {
      expect(stages[0].$match["summaries.date"]).toEqual({
        $gte: new Date("2026-08-24T00:00:00Z"),
        $lt: new Date("2026-08-31T00:00:00Z"),
      });
      expect(stages.find((stage: any) => stage.$limit).$limit).toBe(250);
      expect(stages.findIndex((stage: any) => stage.$sort)).toBeLessThan(
        stages.findIndex((stage: any) => stage.$limit),
      );
    }
    expect(facet.entries.find((stage: any) => stage.$limit).$limit).toBe(100);
    expect(facet.objectCount.at(-2)).toEqual({ $group: { _id: "$_id" } });
  });

  it("counts the whole period when amount is omitted and bounds amount-only display", () => {
    const period = buildSummaryHistoryPipeline({
      from: "2026-08-24",
      to: "2026-08-30",
    })[2].$facet as any;
    expect(period.objectCount.some((stage: any) => stage.$limit)).toBe(false);
    expect(period.selectedObjects).toBeUndefined();
    const amount = buildSummaryHistoryPipeline({ amount: 25, limit: 100 })[2]
      .$facet as any;
    expect(amount.entries.find((stage: any) => stage.$limit).$limit).toBe(25);
    expect(() => buildSummaryHistoryPipeline({ amount: 0 })).toThrow();
  });

  it("reports matched conversations separately from summary versions", () => {
    expect(
      normalizeSummaryHistoryResult([{
        total: [{ value: 100 }],
        objectCount: [{ value: 98 }],
        selectedObjects: [{ id: "conversation-1" }],
      }]),
    )
      .toMatchObject({
        total: 100,
        objectCount: 98,
        selectedObjectIds: ["conversation-1"],
      });
  });

  it("filters by executed model and generated date", () => {
    const pipeline = buildSummaryHistoryPipeline({
      model: "Qwen.gguf",
      from: "2026-07-01",
      to: "2026-07-27",
      limit: 25,
    });

    const facet = pipeline[2].$facet as any;
    expect(facet.entries[0].$match.$expr.$eq[1]).toBe("Qwen.gguf");
    expect(facet.entries[0].$match["summaries.date"].$gte).toBeInstanceOf(Date);
    expect(facet.entries[0].$match["summaries.date"].$lte).toBeInstanceOf(Date);
    expect(facet.entries[2].$limit).toBe(25);
  });

  it("keeps the model list independent from active filters", () => {
    const pipeline = buildSummaryHistoryPipeline({ model: "Qwen.gguf" });
    const facet = pipeline[2].$facet as any;

    expect(facet.models[0].$project.model).toBeDefined();
    expect(facet.models.some((stage: any) => stage.$match?.$expr)).toBe(false);
  });

  it("projects conversation emoji and exact summary source references", () => {
    const pipeline = buildSummaryHistoryPipeline({ limit: 10 });
    const facet = pipeline[2].$facet as any;
    const projection = facet.entries.find((stage: any) => stage.$project)
      .$project;

    expect(projection.objectEmoji).toBe("$icon.text");
    expect(projection.sourceRefs).toBe("$summaries.sourceRefs");
  });

  it("normalizes an empty aggregation response", () => {
    expect(normalizeSummaryHistoryResult([])).toEqual({
      entries: [],
      models: [],
      total: 0,
      objectCount: 0,
      selectedObjectIds: [],
    });
  });
});

describe("summary task aggregation", () => {
  it("filters unfinished jobs and keeps status counts independent", () => {
    const pipeline = buildSummaryTaskPipeline({
      status: "unfinished",
      model: "small",
      from: "2026-07-01",
      limit: 25,
    });
    const facet = pipeline[1].$facet as any;

    expect(facet.entries[0].$match.state.$in).toEqual([
      "active",
      "waiting",
      "delayed",
      "paused",
    ]);
    expect(facet.entries[0].$match["data.model"]).toBe("small");
    expect(facet.entries[2].$limit).toBe(25);
    expect(facet.counts[0].$match.state).toBeUndefined();
  });

  it("normalizes empty task statistics", () => {
    expect(normalizeSummaryTaskResult([])).toEqual({
      entries: [],
      models: [],
      counts: {
        total: 0,
        completed: 0,
        unfinished: 0,
        failed: 0,
        cancelled: 0,
      },
    });
  });
});
