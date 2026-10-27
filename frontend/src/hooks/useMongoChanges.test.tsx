import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMongoChanges } from "./useMongoChanges";
const { subscription } = vi.hoisted(() => ({
  subscription: { callback: (_: unknown) => {} },
}));
vi.mock(
  "./useWebSocket",
  () => ({
    useWebSocketSubscription: (
      _: string,
      callback: (event: unknown) => void,
    ) => {
      subscription.callback = callback;
    },
  }),
);
afterEach(() => vi.useRealTimers());
describe("Minimal Mongo notifications", () => {
  it("batches IDs and changed fields without requiring a document", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    renderHook(() => useMongoChanges("mongo:objects", callback));
    act(() => {
      subscription.callback({
        event: "mongo.change",
        data: {
          collection: "objects",
          documentId: "one",
          operationType: "update",
          changedFields: ["name"],
        },
      });
      subscription.callback({
        event: "mongo.change",
        data: {
          collection: "objects",
          documentId: "one",
          operationType: "update",
          changedFields: ["summary"],
        },
      });
      vi.advanceTimersByTime(200);
    });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0][0]).toEqual([{
      collection: "objects",
      documentId: "one",
      operationType: "update",
      changedFields: ["name", "summary"],
    }]);
  });
  it("does not refresh a page after its subscription unmounts", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const hook = renderHook(() => useMongoChanges("mongo:objects", callback));
    act(() =>
      subscription.callback({
        event: "mongo.change",
        data: {
          collection: "objects",
          documentId: "one",
          operationType: "delete",
        },
      })
    );
    hook.unmount();
    act(() => vi.advanceTimersByTime(500));
    expect(callback).not.toHaveBeenCalled();
  });
  it("serializes canonical refreshes when a newer event arrives during a request", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const callback = vi.fn().mockImplementationOnce(() =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    ).mockResolvedValue(undefined);
    renderHook(() => useMongoChanges("mongo:objects", callback));
    const event = {
      event: "mongo.change",
      data: {
        collection: "objects",
        documentId: "one",
        operationType: "update",
        changedFields: ["name"],
      },
    };
    act(() => {
      subscription.callback(event);
      vi.advanceTimersByTime(200);
    });
    act(() => {
      subscription.callback(event);
      vi.advanceTimersByTime(500);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
