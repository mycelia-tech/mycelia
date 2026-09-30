import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { callResource } from "@/lib/api";
import PhotoAnalysisSettingsPage from "./PhotoAnalysisSettingsPage";

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));

describe("photo analysis settings", () => {
  it("reuses an existing connection without fetching secrets or testing automatically", async () => {
    vi.mocked(callResource).mockResolvedValue({
      googleEnabled: false,
      profiles: [],
      connections: [{
        id: "local",
        name: "Local vision",
        enabled: true,
        credentialConfigured: true,
      }],
    });
    render(
      <MemoryRouter>
        <PhotoAnalysisSettingsPage />
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "Local vision" });
    expect(screen.getByText("Google is off")).toBeInTheDocument();
    expect(callResource).toHaveBeenCalledTimes(1);
    expect(callResource).toHaveBeenCalledWith("media", {
      action: "photoSettings",
    });
    fireEvent.change(screen.getByLabelText("Connection"), {
      target: { value: "local" },
    });
    fireEvent.change(screen.getByLabelText("Vision model"), {
      target: { value: "vision-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(callResource).toHaveBeenCalledWith(
        "media",
        expect.objectContaining({
          action: "savePhotoProfile",
          profile: expect.objectContaining({
            connectionId: "local",
            model: "vision-model",
            language: "Russian",
          }),
        }),
      )
    );
    expect(
      vi.mocked(callResource).mock.calls.some(([, request]) =>
        (request as any).action === "testPhotoProfile"
      ),
    ).toBe(false);
  });
});
