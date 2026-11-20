// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapTimeNavigator } from "./MapTimeNavigator";

afterEach(cleanup);
const summary = {
  dataRange: { start: new Date(0), end: new Date(10_000) },
  range: { start: new Date(1_000), end: new Date(9_000) },
  bucketMs: 5_000,
  buckets: [
    {
      start: new Date(0),
      end: new Date(5_000),
      dwellMs: 1_000,
      stayCount: 1,
      conversationCount: 2,
    },
    {
      start: new Date(5_000),
      end: new Date(10_000),
      dwellMs: 2_000,
      stayCount: 1,
      conversationCount: 3,
    },
  ],
  projection: { status: "ready" as const, revision: 1, stale: false },
};
function setup() {
  const onCommitRange = vi.fn();
  const onSelectTime = vi.fn();
  render(
    <MapTimeNavigator
      summary={summary}
      start={new Date(1_000)}
      end={new Date(9_000)}
      onCommitRange={onCommitRange}
      onSelectTime={onSelectTime}
    />,
  );
  return { onCommitRange, onSelectTime };
}
describe("MapTimeNavigator", () => {
  it("explains both independent chart rows and date range handles", () => {
    setup();
    expect(screen.getByText("Time at stops")).toBeTruthy();
    expect(screen.getByText("Conversations")).toBeTruthy();
    expect(screen.getByText("Each row has its own scale")).toBeTruthy();
    expect(screen.getAllByRole("slider")).toHaveLength(2);
    expect(
      screen.getByRole("slider", { name: "Selected period start" })
        .getAttribute("aria-valuenow"),
    ).toBe("1000");
    expect(
      screen.getByRole("slider", { name: "Selected period end" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("9000");
  });
  it("keyboard adjustment commits an ordered range", () => {
    const { onCommitRange } = setup();
    fireEvent.keyDown(
      screen.getByRole("slider", { name: "Selected period start" }),
      { key: "ArrowRight" },
    );
    expect(onCommitRange).toHaveBeenCalledTimes(1);
    expect(onCommitRange.mock.calls[0].map((date: Date) => date.getTime()))
      .toEqual([1001, 9000]);
  });
  it("inspecting a chart bucket does not change the selected date range", () => {
    const { onCommitRange, onSelectTime } = setup();
    fireEvent.click(screen.getByRole("button", { name: /2 conversations$/ }));
    expect(onSelectTime.mock.calls[0][0].getTime()).toBe(2500);
    expect(onCommitRange).not.toHaveBeenCalled();
  });
  it("validates dates and commits the edited period once", () => {
    const { onCommitRange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Edit dates" }));
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    const apply = screen.getByRole("button", { name: "Apply" });

    fireEvent.change(from, { target: { value: "2026-11-18T09:30" } });
    fireEvent.change(to, { target: { value: "2026-11-17T12:00" } });
    fireEvent.click(apply);
    expect(screen.getByRole("alert").textContent).toMatch(/after the start/);
    expect(onCommitRange).not.toHaveBeenCalled();

    fireEvent.change(to, { target: { value: "2026-11-18T12:00" } });
    fireEvent.click(apply);
    expect(onCommitRange).toHaveBeenCalledExactlyOnceWith(
      new Date("2026-11-18T09:30"),
      new Date("2026-11-18T12:00"),
    );
    expect(screen.getByText("2h 30m selected")).toBeTruthy();
  });
  it("keeps the current range selectable when summary data covers less time", () => {
    render(
      <MapTimeNavigator
        summary={summary}
        start={new Date(-1000)}
        end={new Date(20000)}
        onCommitRange={vi.fn()}
        onSelectTime={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("slider", { name: "Selected period start" })
        .getAttribute("aria-valuenow"),
    ).toBe("-1000");
    expect(
      screen.getByRole("slider", { name: "Selected period end" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("20000");
  });
});
