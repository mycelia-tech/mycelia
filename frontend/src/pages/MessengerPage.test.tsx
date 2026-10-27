import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MessengerPage from "./MessengerPage";
const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ callResource: callMock }));
vi.mock("@/lib/formatTime", () => ({ useFormattedTime: () => "Today" }));
vi.mock(
  "@/modules/messenger/core/registry.ts",
  () => ({ registry: { register: vi.fn(), setDefault: vi.fn() } }),
);
vi.mock(
  "@/modules/messenger/platforms/default.tsx",
  () => ({ defaultPlatform: { id: "default" } }),
);
vi.mock(
  "@/modules/messenger/platforms/telegram.tsx",
  () => ({ telegramPlatform: {} }),
);
vi.mock(
  "@/modules/messenger/platforms/signal.tsx",
  () => ({ signalPlatform: {} }),
);
vi.mock(
  "@/modules/messenger/platforms/mycelia.tsx",
  () => ({ myceliaPlatform: {} }),
);
vi.mock(
  "@/components/ai-elements/code-block",
  () => ({ CodeBlock: () => null }),
);
vi.mock(
  "@/modules/messenger/components/ChatListItem.tsx",
  () => ({
    ChatListItem: (
      { chat, onClick }: { chat: { name: string }; onClick: () => void },
    ) => <button type="button" onClick={onClick}>{chat.name}</button>,
  }),
);
vi.mock(
  "@/modules/messenger/components/MessageBubble.tsx",
  () => ({
    MessageBubble: ({ message }: { message: { text: string } }) => (
      <p>{message.text}</p>
    ),
  }),
);
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));
vi.mock(
  "react-infinite-scroll-component",
  () => ({
    default: (
      { children, next, hasMore }: {
        children: ReactNode;
        next: () => void;
        hasMore: boolean;
      },
    ) => (
      <div>
        {children}
        {hasMore && <button type="button" onClick={next}>Load older</button>}
      </div>
    ),
  }),
);
const chatId = "64b000000000000000000001";
function mount(path = "/messaging") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/messaging/:chatId?" element={<MessengerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  callMock.mockReset();
});
describe("Messenger failure states", () => {
  it("shows failed chat loading separately from an empty archive and retries", async () => {
    callMock.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(
      [],
    );
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.queryByText("No chats found")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No chats found")).toBeInTheDocument();
  });
  it("shows initial message loading and retries a failed request", async () => {
    let reject: (error: Error) => void = () => {};
    let messageCalls = 0;
    callMock.mockImplementation((_resource, input) =>
      input.collection === "chats"
        ? Promise.resolve([])
        : ++messageCalls === 1
        ? new Promise((_resolve, fail) => {
          reject = fail;
        })
        : Promise.resolve([{
          _id: "m1",
          text: "Recovered message",
          timestamp: new Date(),
        }])
    );
    mount(`/messaging/${chatId}`);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading messages",
    );
    reject(new Error("Server unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server unavailable",
    );
    expect(screen.queryByText("Linked message unavailable")).not
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Recovered message")).toBeInTheDocument();
  });
  it("keeps loaded messages when older-message loading fails", async () => {
    let messageCalls = 0;
    const messages = Array.from(
      { length: 51 },
      (_, index) => ({
        _id: `m${index}`,
        text: `Message ${index}`,
        timestamp: new Date(2026, 0, 1, 0, index),
      }),
    );
    callMock.mockImplementation((_resource, input) =>
      input.collection === "chats"
        ? Promise.resolve([])
        : ++messageCalls === 1
        ? Promise.resolve(messages)
        : messageCalls === 2
        ? Promise.reject(new Error("Pagination offline"))
        : Promise.resolve([{
          _id: "older",
          text: "Older recovered",
          timestamp: new Date(2025, 0, 1),
        }])
    );
    mount(`/messaging/${chatId}`);
    expect(await screen.findByText("Message 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pagination offline",
    );
    expect(screen.getByText("Message 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Older recovered")).toBeInTheDocument();
  });
});
