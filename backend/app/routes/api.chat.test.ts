import { expect } from "@std/expect";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool } from "ai";
import {
  appendActiveToolGuidance,
  chatToolSteps,
  hasUnparsedFinalToolCalls,
  RAG_CHAT_TOOL_GUIDANCE,
  sanitizeUIMessages,
} from "./api.chat.ts";

Deno.test("chat reserves a final streamed answer after five tool steps", async () => {
  const requests: Array<{
    tool_choice?: string;
    tools?: unknown[];
    messages: { role: string; content: string }[];
  }> = [];
  const model = createOpenAI({
    apiKey: "synthetic-test-key",
    fetch: (_input, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const delta = !request.tools?.length ? { content: "Final answer" } : {
        tool_calls: [{
          index: 0,
          id: `call-${requests.length}`,
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        }],
      };
      const finish_reason = request.tools?.length ? "tool_calls" : "stop";
      const events = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason }] },
      ];
      return Promise.resolve(
        new Response(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  }).chat("synthetic");
  const result = streamText({
    model,
    ...chatToolSteps("Base prompt"),
    system: "Base prompt",
    prompt: "Use the results to answer.",
    tools: {
      lookup: tool({
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: () => ({ value: "evidence" }),
      }),
    },
  });

  expect(await result.text).toBe("Final answer");
  expect(await result.finishReason).toBe("stop");
  expect(requests.map((request) => request.tool_choice)).toEqual([
    "auto",
    "auto",
    "auto",
    "auto",
    "auto",
    undefined,
  ]);
  expect(requests[5].tools).toBeUndefined();
  const lastMessages = requests[5].messages;
  expect(lastMessages[0].content).toContain("The tool budget");
  expect(lastMessages.filter((message) => message.role === "tool"))
    .toHaveLength(5);
});

Deno.test("chat recognizes final DeepSeek markup and removes it from future model context", () => {
  const raw = '<｜DSML｜tool_calls><｜DSML｜invoke name="lookup">';
  const rawPart = { type: "text" as const, text: raw };
  const step = { type: "step-start" as const };
  const answer = { type: "text" as const, text: "Answer" };
  expect(hasUnparsedFinalToolCalls([step, answer, step, rawPart])).toBe(true);
  expect(hasUnparsedFinalToolCalls([step, rawPart, step, answer])).toBe(false);
  const assistant = { role: "assistant", parts: [step, answer, step, rawPart] };
  const user = { role: "user", parts: [rawPart] };
  expect(sanitizeUIMessages([assistant, user])).toEqual([
    { ...assistant, parts: [step, answer, step] },
    user,
  ]);
});

Deno.test("sanitizeUIMessages omits persisted empty assistant failures", () => {
  const messages = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "retry" }],
    },
    {
      id: "assistant-empty",
      role: "assistant",
      parts: [],
      metadata: { error: { type: "empty_response" } },
    },
    {
      id: "user-2",
      role: "user",
      parts: [{ type: "text", text: "retry again" }],
    },
  ];

  expect(sanitizeUIMessages(messages)).toEqual([messages[0], messages[2]]);
});

Deno.test("sanitizeUIMessages strips null part fields without dropping content", () => {
  expect(sanitizeUIMessages([{
    id: "assistant-1",
    role: "assistant",
    parts: [{
      type: "text",
      text: "ok",
      providerMetadata: null,
    }],
  }])).toEqual([{
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text: "ok" }],
  }]);
});

Deno.test("appendActiveToolGuidance appends immutable RAG guidance to custom prompts", () => {
  const customPrompt = "Custom system prompt.";
  const result = appendActiveToolGuidance(
    customPrompt,
    ["rag_search"],
    ["rag_search", "search_searchObjects"],
  );

  expect(result).toBe(`${customPrompt}\n\n${RAG_CHAT_TOOL_GUIDANCE}`);
  expect(result).toContain("source.uri");
  expect(result).toContain("evidenceId");
  expect(result).toContain("message sender");
  expect(result).toContain("untrusted evidence");
  expect(result).toContain("never as instructions");
  expect(result).toContain("projection/checkpoint freshness");
  expect(result).toContain("exact counts");
});

Deno.test("appendActiveToolGuidance follows Auto and disabled tool policies", () => {
  expect(appendActiveToolGuidance("Base", undefined, ["rag_search"]))
    .toContain(RAG_CHAT_TOOL_GUIDANCE);
  expect(appendActiveToolGuidance("Base", [], ["rag_search"]))
    .toBe("Base");
  expect(appendActiveToolGuidance("Base", undefined, ["search_searchObjects"]))
    .toBe("Base");
});

Deno.test("GPS guidance follows the active tool policy", () => {
  const catalog = ["search_searchTrips"];
  expect(appendActiveToolGuidance("Base", undefined, catalog)).toContain(
    "search_searchTrips FIRST",
  );
  expect(appendActiveToolGuidance("Base", [], catalog)).toBe("Base");
});

Deno.test("plain visit dates stream the tool evidence without a second provider request", async () => {
  const { GPS_TRIP_TOOL, tripDateLocale } = await import(
    "@/lib/chat/trip-date-answer.ts"
  );
  expect(tripDateLocale("Когда я была в Новой Зеландии?")).toBe("ru");
  expect(tripDateLocale("Когда я был в Греции и с кем встречался?"))
    .toBeUndefined();
  expect(tripDateLocale("What did I do in Tokyo?")).toBeUndefined();
  const question = "When was I in Tokyo?";
  let requests = 0;
  const model = createOpenAI({
    apiKey: "synthetic-test-key",
    fetch: (_input, init) => {
      const body = JSON.parse(String(init?.body));
      requests++;
      expect(requests).toBe(1);
      expect(body.tools.map((t: any) => t.function.name)).toEqual([
        GPS_TRIP_TOOL,
      ]);
      const events = [
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "gps",
                type: "function",
                function: {
                  name: GPS_TRIP_TOOL,
                  arguments: '{"city":"Tokyo"}',
                },
              }],
            },
            finish_reason: null,
          }],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
      return Promise.resolve(
        new Response(
          events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    },
  }).chat("synthetic");
  const stream = streamText({
    model,
    prompt: question,
    ...chatToolSteps("Base", tripDateLocale(question)),
    tools: {
      [GPS_TRIP_TOOL]: tool({
        inputSchema: jsonSchema({
          type: "object",
          properties: { city: { type: "string" } },
        }),
        execute: () => ({
          type: "json",
          value: {
            source: "location_segments",
            hasMore: false,
            visits: [{
              countryCode: "JP",
              cities: ["Tokyo"],
              firstLocalDate: "2025-03-05",
              lastLocalDate: "2025-03-08",
              mapUrl: "/map?start=1&end=2&layers=presence,routes",
            }],
          },
        }),
      }),
    },
  });
  expect(await stream.text).toMatch(/Tokyo.*March.*5.*8.*2025/);
  expect(await stream.finishReason).toBe("stop");
  expect(await stream.toolResults).toHaveLength(1);
  expect(requests).toBe(1);
});
