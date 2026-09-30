import { describe, expect, it } from "vitest";
import {
  chatStatusLabel,
  isChatRunActive,
  isNearBottom,
  shouldNotifyForChatEvent,
} from "./chat";

describe("chatStatusLabel", () => {
  it("prioritizes approval and live SDK states", () => {
    expect(chatStatusLabel("ready", { state: "needs_approval" }, true))
      .toBe("Needs approval");
    expect(chatStatusLabel("submitted")).toBe("Sending");
    expect(chatStatusLabel("streaming")).toBe("Answering");
    expect(chatStatusLabel("ready", { state: "failed" })).toBe("Error");
  });
});

describe("isChatRunActive", () => {
  it("locks controls for every non-terminal response state", () => {
    expect(isChatRunActive("submitted")).toBe(true);
    expect(isChatRunActive("streaming")).toBe(true);
    expect(isChatRunActive("needs_approval")).toBe(true);
    expect(isChatRunActive("completed")).toBe(false);
    expect(isChatRunActive("failed")).toBe(false);
    expect(isChatRunActive()).toBe(false);
  });
});

describe("chat notification rules", () => {
  it("does not notify for the visible active chat", () => {
    expect(shouldNotifyForChatEvent({
      state: "completed",
      eventChatId: "chat-a",
      activeChatId: "chat-a",
      documentHidden: false,
    })).toBe(false);
  });

  it("notifies for another chat or a hidden tab", () => {
    expect(shouldNotifyForChatEvent({
      state: "completed",
      eventChatId: "chat-a",
      activeChatId: "chat-b",
      documentHidden: false,
    })).toBe(true);
    expect(shouldNotifyForChatEvent({
      state: "needs_approval",
      eventChatId: "chat-a",
      activeChatId: "chat-a",
      documentHidden: true,
    })).toBe(true);
  });
});

describe("isNearBottom", () => {
  it("respects the jump-to-latest threshold", () => {
    expect(
      isNearBottom(
        {
          scrollHeight: 1000,
          scrollTop: 780,
          clientHeight: 200,
        } as HTMLElement,
      ),
    ).toBe(true);
    expect(
      isNearBottom(
        {
          scrollHeight: 1000,
          scrollTop: 400,
          clientHeight: 200,
        } as HTMLElement,
      ),
    ).toBe(false);
  });
});
