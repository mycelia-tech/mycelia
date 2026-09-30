import { render, screen } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateTimePicker } from "./datetime-picker";

const userEvent = (userEventLib as any).default || userEventLib;

describe("DateTimePicker date precision", () => {
  it("hides the clock and applies the selected day at midnight in its timezone", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateTimePicker
        value={new Date("2026-08-26T00:41:38.000Z")}
        onChange={onChange}
        precision="date"
        timeZone="Asia/Yerevan"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Aug 26, 2026" }));
    expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith(
      new Date("2026-08-25T20:00:00.000Z"),
    );
  });

  it("applies a different calendar day without introducing a time", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateTimePicker
        value={new Date("2026-08-26T00:41:38.000Z")}
        onChange={onChange}
        precision="date"
        timeZone="Asia/Yerevan"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Aug 26, 2026" }));
    await user.click(screen.getByRole("button", {
      name: /Tuesday, August 25th, 2026/,
    }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith(
      new Date("2026-08-24T20:00:00.000Z"),
    );
  });
});
