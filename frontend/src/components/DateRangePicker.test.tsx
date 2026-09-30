import { fireEvent, render, screen } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateRangePicker } from "./DateRangePicker";
import { TimeRangeEditDialog } from "./TimeRangeEditDialog";

const userEvent = (userEventLib as any).default || userEventLib;

vi.mock("@/modules/histogram/useHistogramItems", () => ({
  useHistogramItems: () => ({
    resolution: "1hour",
    items: [{
      id: "audio-hour",
      start: new Date("2026-08-24T10:00:00Z"),
      end: new Date("2026-08-24T11:00:00Z"),
      stale: false,
      totals: { seconds: 3600, audio_chunks: { count: 60 } },
    }],
  }),
}));

describe("DateRangePicker", () => {
  it("advances the timeline start one second per arrow without snapping back to audio bins", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangePicker
        value={{
          start: new Date("2026-08-24T10:00:00Z"),
          end: new Date("2026-08-24T11:00:00Z"),
        }}
        precision="second"
        timeZone="UTC"
        showAudioTimeline
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button"));
    const start = screen.getByRole("slider", { name: "Range start" });
    const end = screen.getByRole("slider", { name: "Range end" });
    start.focus();

    for (const seconds of ["01", "02", "03"]) {
      await user.keyboard("{ArrowRight}");
      expect(screen.getByLabelText("Start", { selector: "input" }))
        .toHaveValue(`10:00:${seconds}`);
      expect(end).toHaveAttribute("aria-valuenow", "1787569200000");
      expect(onChange).not.toHaveBeenCalled();
    }

    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      start: new Date("2026-08-24T10:00:03Z"),
      end: new Date("2026-08-24T11:00:00Z"),
    });
  });

  it("keeps navigation and scrollable month/year dropdowns inside the dialog", async () => {
    const user = userEvent.setup();
    const view = render(
      <DateRangePicker
        label="Audio range"
        value={{
          start: new Date("2026-08-24T00:41:00.000Z"),
          end: new Date("2026-08-25T00:41:00.000Z"),
        }}
        onChange={vi.fn()}
        timeZone="Asia/Yerevan"
      />,
    );

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(view.container.querySelector('input[type="date"]')).toBeNull();

    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("dialog", { name: "Audio range" })).not.toBeNull();
    expect(screen.getByText("Exact time")).not.toBeNull();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThanOrEqual(2);
    const scrollContainer = view.container.ownerDocument.querySelector(
      '[data-slot="date-range-picker-scroll"]',
    ) as HTMLDivElement;
    expect(scrollContainer.className).toContain("overflow-y-auto");

    const month = screen.getByRole("combobox", { name: "Choose the Month" });
    expect(month.textContent).toContain("Aug");
    await user.click(screen.getByRole("button", {
      name: "Go to the Next Month",
    }));
    expect(month.textContent).toContain("Sep");

    const year = screen.getByRole("combobox", { name: "Choose the Year" });
    await user.click(year);
    await user.click(screen.getByRole("option", { name: "2025" }));
    expect(year.textContent).toContain("2025");
    expect(screen.getByRole("dialog", { name: "Audio range" })).not.toBeNull();

    const timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs).toHaveLength(2);
    expect(timeInputs[0]?.getAttribute("step")).toBe("60");
    expect(screen.queryByText("End date")).toBeNull();

    scrollContainer.scrollTop = 120;
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(view.container.querySelector("button")!);
    expect(
      view.container.ownerDocument.querySelector<HTMLDivElement>(
        '[data-slot="date-range-picker-scroll"]',
      )?.scrollTop,
    ).toBe(0);
  });

  it("edits the explicitly selected Start or End boundary", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangePicker
        label="Audio range"
        value={{
          start: new Date("2026-08-24T00:41:00.000Z"),
          end: new Date("2026-08-25T00:41:00.000Z"),
        }}
        onChange={onChange}
        timeZone="Asia/Yerevan"
      />,
    );

    await user.click(screen.getByRole("button"));
    const start = screen.getByRole("button", { name: /^Start / });
    const end = screen.getByRole("button", { name: /^End / });
    expect(start.getAttribute("aria-pressed")).toBe("true");

    await user.click(start);
    await user.click(screen.getByRole("button", {
      name: /Sunday, August 23rd, 2026/,
    }));
    expect(start.textContent).toContain("Aug 23, 2026");
    expect(end.getAttribute("aria-pressed")).toBe("true");

    await user.click(end);
    await user.click(screen.getByRole("button", {
      name: /Sunday, August 30th, 2026/,
    }));
    expect(end.textContent).toContain("Aug 30, 2026");
    expect(screen.getByRole("button", { name: /Sunday, August 23rd, 2026/ }))
      .toHaveAttribute("data-range-start", "true");
    expect(screen.getByRole("button", { name: /Monday, August 24th, 2026/ }))
      .toHaveAttribute("data-range-middle", "true");
    expect(screen.getByRole("button", { name: /Sunday, August 30th, 2026/ }))
      .toHaveAttribute("data-range-end", "true");

    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].start.toISOString()).toBe(
      "2026-08-23T00:41:00.000Z",
    );
    expect(onChange.mock.calls[0][0].end.toISOString()).toBe(
      "2026-08-30T00:41:00.000Z",
    );
  });

  it("keeps seconds opt-in for precision workflows", async () => {
    const user = userEvent.setup();
    render(
      <DateRangePicker
        value={{
          start: new Date("2026-08-24T00:41:38.000Z"),
          end: new Date("2026-08-25T00:41:38.000Z"),
        }}
        onChange={vi.fn()}
        precision="second"
        timeZone="Asia/Yerevan"
      />,
    );

    await user.click(screen.getByRole("button"));

    const timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs[0]?.getAttribute("step")).toBe("1");
    expect((timeInputs[0] as HTMLInputElement).value).toBe("04:41:38");
  });

  it("jumps to the chosen boundary when start and end are months apart", async () => {
    const user = userEvent.setup();
    render(
      <DateRangePicker
        value={{
          start: new Date("2026-01-10T10:00:00Z"),
          end: new Date("2026-08-25T11:00:00Z"),
        }}
        onChange={vi.fn()}
        timeZone="UTC"
      />,
    );
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button", { name: /^End / }));
    expect(screen.getByRole("grid", { name: "August 2026" }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Start / }));
    expect(screen.getByRole("grid", { name: "January 2026" }))
      .toBeInTheDocument();
  });

  it("allows the same calendar day in date-only mode despite incoming clock values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangePicker
        precision="date"
        value={{
          start: new Date("2026-08-24T10:41:00Z"),
          end: new Date("2026-08-25T12:41:00Z"),
        }}
        onChange={onChange}
        timeZone="Asia/Tbilisi"
      />,
    );
    await user.click(screen.getByRole("button"));
    await user.click(screen.getByRole("button", { name: /^End / }));
    await user.click(
      screen.getByRole("button", { name: /Monday, August 24th, 2026/ }),
    );
    expect(screen.getByRole("button", { name: "Apply range" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onChange.mock.calls[0][0].start.toISOString()).toBe(
      "2026-08-23T20:00:00.000Z",
    );
    expect(onChange.mock.calls[0][0].end.toISOString()).toBe(
      "2026-08-23T20:00:00.000Z",
    );
  });

  it("rejects exact times outside the allowed bounds including an open end", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangePicker
        allowOpenEnd
        value={{
          start: new Date("2026-08-24T10:00:00Z"),
          end: new Date("2026-08-24T11:00:00Z"),
        }}
        minDate={new Date("2026-08-24T09:00:00Z")}
        maxDate={new Date("2026-08-24T12:00:00Z")}
        onChange={onChange}
        timeZone="UTC"
      />,
    );
    await user.click(screen.getByRole("button"));
    fireEvent.change(screen.getByLabelText("End", { selector: "input" }), {
      target: { value: "12:30" },
    });
    expect(screen.getByRole("button", { name: "Apply range" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("End", { selector: "input" }), {
      target: { value: "11:00" },
    });
    await user.click(screen.getByRole("button", { name: "No finish" }));
    fireEvent.change(screen.getByLabelText("Start", { selector: "input" }), {
      target: { value: "08:30" },
    });
    expect(screen.getByRole("button", { name: "Apply range" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("blocks reversed and over-limit processing ranges until corrected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangePicker
        value={{
          start: new Date("2026-08-24T10:00:00Z"),
          end: new Date("2026-08-25T11:00:00Z"),
        }}
        maxDurationMs={24 * 60 * 60 * 1000}
        onChange={onChange}
        timeZone="UTC"
      />,
    );
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("alert")).toHaveTextContent("allowed 24 hours");
    expect(screen.getByRole("button", { name: "Apply range" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /^End / }));
    await user.click(
      screen.getByRole("button", { name: /Monday, August 24th, 2026/ }),
    );
    fireEvent.change(screen.getByLabelText("End", { selector: "input" }), {
      target: { value: "09:00" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("finish must be after");
    expect(screen.getByRole("button", { name: "Apply range" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("End", { selector: "input" }), {
      target: { value: "12:00" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onChange).toHaveBeenCalledWith({
      start: new Date("2026-08-24T10:00:00Z"),
      end: new Date("2026-08-24T12:00:00Z"),
    });
  });

  it("keeps the outer editor open on inner cancellation and applies an open end only on save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <TimeRangeEditDialog
        open
        onOpenChange={onOpenChange}
        timeRange={{
          start: new Date("2026-08-24T10:00:38Z"),
          end: new Date("2026-08-25T11:00:38Z"),
        }}
        index={0}
        onSave={onSave}
        onDelete={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Time range" }));
    await user.click(screen.getByRole("button", { name: "No finish" }));
    await user.click(
      screen.getByRole("button", { name: "Cancel", exact: true }),
    );
    expect(screen.getByRole("dialog", { name: "Edit Time Range 1" }))
      .toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Time range" }));
    expect(screen.getByRole("button", { name: "No finish" }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No finish" }));
    await user.click(screen.getByRole("button", { name: "Apply range" }));
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onSave).toHaveBeenCalledWith(0, {
      start: new Date("2026-08-24T10:00:38Z"),
      end: undefined,
      name: undefined,
    });
  });
});
