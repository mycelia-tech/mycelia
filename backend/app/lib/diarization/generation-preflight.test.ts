import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.15";
import { assertDiarizationGenerationReady } from "./generation-preflight.ts";

Deno.test("build_generation requires a building run", () => {
  assertThrows(
    () =>
      assertDiarizationGenerationReady(
        { type: "diarization", mode: "build_generation", runId: "old-run" },
        { runId: "old-run", status: "ready" },
      ),
    Error,
    "Create a new diarization generation",
  );
});

Deno.test("active continuation keeps using its building run", () => {
  assertEquals(
    assertDiarizationGenerationReady(
      { type: "diarization", mode: "build_generation", runId: "new-run" },
      { runId: "new-run", status: "building" },
    ),
    undefined,
  );
});

Deno.test("non-generation diarization does not require a run", () => {
  assertEquals(
    assertDiarizationGenerationReady(
      { type: "diarization", mode: "missing" },
      null,
    ),
    undefined,
  );
});
