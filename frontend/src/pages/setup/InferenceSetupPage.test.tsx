import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InferenceSetupPage from "./InferenceSetupPage";
const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ callResource: callMock }));
vi.mock("@/lib/auth", () => ({ getCurrentJWT: vi.fn() }));
vi.mock(
  "@/stores/settingsStore",
  () => ({ useSettingsStore: () => ({ sessionStatus: "authenticated" }) }),
);
function mount() {
  render(
    <MemoryRouter initialEntries={["/setup/inference"]}>
      <Routes>
        <Route path="/setup/inference" element={<InferenceSetupPage />} />
        <Route path="/" element={<p>Home</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  callMock.mockReset().mockImplementation((_resource, input) =>
    input.action === "get"
      ? Promise.resolve({})
      : input.action === "probe"
      ? Promise.resolve({
        success: false,
        available: false,
        message: "Offline",
      })
      : Promise.resolve({})
  );
});
describe("Inference setup readiness", () => {
  it("reports saved configuration separately from an untested connection", async () => {
    mount();
    fireEvent.change(await screen.findByLabelText("Inference API URL"), {
      target: { value: "http://local.test/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(await screen.findByText("Configuration Saved!")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Provider connection has not been checked.*Model generation/,
      ),
    ).toBeInTheDocument();
    expect(callMock.mock.calls.some(([, input]) => input.action === "probe"))
      .toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue to Mycelia" }),
    );
    expect(await screen.findByText("Home")).toBeInTheDocument();
  });
  it("keeps an unavailable connection visible and resets it after endpoint changes", async () => {
    mount();
    const input = await screen.findByLabelText("Inference API URL");
    fireEvent.change(input, { target: { value: "http://local.test/v1" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Check provider connection" }),
    );
    expect(await screen.findByText(/could not be verified: Offline/))
      .toBeInTheDocument();
    expect(callMock).toHaveBeenCalledWith("llm", {
      action: "probe",
      baseUrl: "http://local.test/v1",
      apiKey: "",
    });
    fireEvent.change(input, { target: { value: "http://another.test/v1" } });
    expect(await screen.findByText("Provider connection has not been checked."))
      .toBeInTheDocument();
  });
});
