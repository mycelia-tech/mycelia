import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";
import { ObjectId } from "bson";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/lib/api";
import ChatPage from "./ChatPage";

const { callResource, fetchRaw, writeText } = vi.hoisted(() => ({
  callResource: vi.fn(),
  fetchRaw: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/api")>(),
  callResource,
  apiClient: { fetchRaw },
}));
vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocketSubscription: () => {},
}));
vi.mock("@/modules/messenger/platforms/mycelia", () => ({
  myceliaPlatform: {
    MessageComponent: (
      { message }: { message: { raw: { content: string } } },
    ) => <p>{message.raw.content}</p>,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

it("keeps the original text copyable across draft and response failures", async () => {
  const attempts: { chatId: string; initialText: string }[] = [];
  callResource.mockImplementation((resource, input) => {
    if (resource === "llm") {
      return Promise.resolve({
        models: [{ id: "working-model" }],
        providers: [{ id: "local", name: "Local", models: ["working-model"] }],
        chatDefaultModel: "working-model",
      });
    }
    if (input.action === "createDraft") {
      attempts.push(input);
      if (attempts.length === 1) {
        return Promise.reject(
          new ApiRequestError("Could not save chat", "draft-request-id"),
        );
      }
      return Promise.resolve({});
    }
    return Promise.resolve({ items: [], tools: [] });
  });
  fetchRaw.mockImplementation(() =>
    Promise.resolve(Response.json(
      { error: "Provider rejected the request" },
      {
        status: 503,
        headers: {
          "X-Mycelia-Request-Id": "response-request-id",
          "X-Mycelia-Model": "working-model",
        },
      },
    ))
  );

  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Routes>
        <Route path="/chat/:chatId?" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText("1 model", { exact: false })).toBeVisible();
  const text = "Keep my question available";
  fireEvent.change(screen.getByPlaceholderText("Type a message…"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));

  expect(await screen.findByText("Could not create the chat")).toBeVisible();
  expect(screen.getByText("draft-request-id")).toBeVisible();
  expect(screen.getByText(text)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
  expect(writeText).toHaveBeenCalledWith(text);
  expect(fetchRaw).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Provider rejected the request (HTTP 503)"))
    .toBeVisible();
  expect(screen.getByText("response-request-id")).toBeVisible();
  expect(screen.getAllByText(text)).toHaveLength(1);
  expect(attempts).toHaveLength(2);
  expect(attempts[0].chatId).toBe(attempts[1].chatId);
  expect(attempts[1].initialText).toBe(text);

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(fetchRaw).toHaveBeenCalledTimes(2));
  const [first, second] = fetchRaw.mock.calls.map(([, options]) =>
    JSON.parse(options.body).messages
  );
  expect(second).toEqual(first);
  expect(second).toHaveLength(1);
});

it("keeps the composer open and drains queued messages in order after the stream closes", async () => {
  callResource.mockResolvedValue({ items: [], tools: [], models: [] });
  const responses: ReadableStreamDefaultController<UIMessageChunk>[] = [];
  fetchRaw.mockImplementation(() =>
    Promise.resolve(createUIMessageStreamResponse({
      stream: new ReadableStream<UIMessageChunk>({
        start: (controller) => responses.push(controller),
      }),
    }))
  );

  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Routes>
        <Route path="/chat/:chatId?" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
  const submit = (text: string, queued = false) => {
    fireEvent.change(
      screen.getByPlaceholderText(
        queued ? "Queue your next message…" : "Type a message…",
      ),
      { target: { value: text } },
    );
    fireEvent.click(screen.getByRole("button", {
      name: queued ? "Queue message" : "Submit",
    }));
  };
  submit("First prompt");
  await waitFor(() => expect(responses).toHaveLength(1));
  expect(screen.getByText("Waiting for response…")).toBeVisible();
  expect(screen.getByRole("timer")).toHaveTextContent("0:00");
  await waitFor(
    () => expect(screen.getByRole("timer")).not.toHaveTextContent("0:00"),
    { timeout: 3000 },
  );
  submit("Remove this prompt", true);
  await screen.findByText("Remove this prompt");
  fireEvent.click(
    screen.getByRole("button", { name: "Remove queued message" }),
  );
  submit("Second prompt", true);
  await screen.findByText("Second prompt");
  submit("Third prompt", true);
  expect(await screen.findByText("2 queued")).toBeVisible();
  expect(responses).toHaveLength(1);

  const finish = (index: number, text: string) => {
    const response = responses[index];
    response.enqueue({ type: "start", messageId: `assistant-${index}` });
    response.enqueue({ type: "text-start", id: "text" });
    response.enqueue({ type: "text-delta", id: "text", delta: text });
    response.enqueue({ type: "text-end", id: "text" });
    response.enqueue({ type: "finish", finishReason: "stop" });
    response.close();
  };
  finish(0, "First answer");
  await waitFor(() => expect(responses).toHaveLength(2));
  expect(screen.getByText("1 queued")).toBeVisible();
  finish(1, "Second answer");
  await waitFor(() => expect(responses).toHaveLength(3));
  expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();
  finish(2, "Third answer");
  expect(await screen.findByText("Third answer")).toBeVisible();
  await waitFor(() => expect(screen.queryByRole("timer")).toBeNull());

  const prompts = fetchRaw.mock.calls.map(([, options]) =>
    JSON.parse(options.body).messages.map(
      (message: { parts: { text: string }[] }) => message.parts[0].text,
    )
  );
  expect(prompts).toEqual([
    ["First prompt"],
    ["First prompt", "First answer", "Second prompt"],
    [
      "First prompt",
      "First answer",
      "Second prompt",
      "Second answer",
      "Third prompt",
    ],
  ]);
});

it(
  "reloads another tab's finished answer before sending a queued message",
  async () => {
    const chatId = new ObjectId();
    const replyId = new ObjectId();
    const startedAt = new Date(Date.now() - 75_000);
    let remoteFinished = false;
    callResource.mockImplementation((_resource, input) => {
      if (input.action !== "getMessages") {
        return Promise.resolve({ items: [], tools: [], models: [] });
      }
      return Promise.resolve({
        found: true,
        chat: {
          _id: chatId,
          name: "Remote chat",
          lastRun: {
            state: remoteFinished ? "completed" : "streaming",
            startedAt,
            updatedAt: new Date(remoteFinished ? 2 : 1),
          },
        },
        messages: remoteFinished
          ? [{
            _id: replyId,
            timestamp: new Date(),
            raw: {
              role: "assistant",
              uiMessage: {
                id: replyId.toString(),
                role: "assistant",
                parts: [{ type: "text", text: "Answer from the other tab" }],
              },
            },
          }]
          : [],
      });
    });
    fetchRaw.mockImplementation(() =>
      Promise.resolve(createUIMessageStreamResponse({
        stream: new ReadableStream<UIMessageChunk>(),
      }))
    );
    render(
      <MemoryRouter initialEntries={[`/chat/${chatId}`]}>
        <Routes>
          <Route path="/chat/:chatId?" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Answering")).toBeVisible();
    expect(screen.getByText("Generating response…")).toBeVisible();
    expect(screen.getByRole("timer")).toHaveTextContent(/^1:\d{2}$/);
    fireEvent.change(screen.getByPlaceholderText("Queue your next message…"), {
      target: { value: "Follow-up from this tab" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }));
    expect(await screen.findByText("1 queued")).toBeVisible();
    expect(fetchRaw).not.toHaveBeenCalled();

    remoteFinished = true;
    await waitFor(() => expect(fetchRaw).toHaveBeenCalledTimes(1), {
      timeout: 6500,
    });
    const messages = JSON.parse(fetchRaw.mock.calls[0][1].body).messages;
    expect(
      messages.map((message: { parts: { text: string }[] }) =>
        message.parts[0].text
      ),
    ).toEqual(["Answer from the other tab", "Follow-up from this tab"]);
  },
  9000,
);
