import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { useBacklogRecovery } from "./useBacklogRecovery";
const { callMock } = vi.hoisted(() => ({
  callMock: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/api", () => ({ api: { callResource: callMock } }));
describe("Jobs backlog recovery", () => {
  it.each([["summarization", true], ["conversation_extractor_merged", true], [
    "tagger",
    false,
  ], ["entity_typing", false]])(
    "keeps the %s worker contract",
    async (worker, retryNow) => {
      callMock.mockClear();
      const client = new QueryClient();
      const refresh = vi.fn();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const hook = renderHook(() => useBacklogRecovery(refresh), { wrapper });
      await act(() => hook.result.current.mutateAsync(worker));
      expect(callMock).toHaveBeenCalledWith("jobs", {
        action: "enqueue",
        data: { type: worker, ...(retryNow ? { retryNow: true } : {}) },
        trigger: { type: "manual", reason: "pipeline_health_run_now" },
      });
      await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    },
  );
});
