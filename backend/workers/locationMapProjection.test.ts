import { expect } from "@std/expect";
import capability, { schema } from "./locationMapProjection.ts";

Deno.test("automatic location projection payload passes its registered job schema", async () => {
  for (
    const reason of [
      "TriggerManager startup check",
      "interval",
      "route_changed",
    ]
  ) {
    const data = await capability.getTriggerJobData?.({}, reason, {
      mongo: () =>
        Promise.reject(new Error("Payload construction must not query Mongo")),
    });
    expect(schema.parse(data)).toEqual({
      type: "locationMapProjection",
      mode: "incremental",
      reparseOriginals: false,
    });
  }
});
