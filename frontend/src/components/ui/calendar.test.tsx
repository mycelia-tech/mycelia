import { useState } from "react";
import { render, screen } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Calendar } from "./calendar";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const userEvent = (userEventLib as any).default || userEventLib;

function ControlledCalendar({ label = "Calendar" }: { label?: string }) {
  const [month, setMonth] = useState(new Date(2026, 7, 15));
  return (
    <Calendar
      aria-label={label}
      captionLayout="dropdown"
      month={month}
      onMonthChange={setMonth}
      startMonth={new Date(2024, 0)}
      endMonth={new Date(2028, 11)}
    />
  );
}

function expectActiveOption(trigger: HTMLElement, label: string) {
  expect(trigger).toHaveFocus();
  expect(trigger.getAttribute("aria-activedescendant")).toBe(
    screen.getByRole("option", { name: label }).id,
  );
}

describe("Calendar dropdown keyboard interaction", () => {
  it("navigates months without committing until Enter and keeps focus after selection", async () => {
    const user = userEvent.setup();
    render(<ControlledCalendar />);
    const month = screen.getByRole("combobox", { name: "Choose the Month" });
    month.focus();

    await user.keyboard("{ArrowDown}");
    expectActiveOption(month, "Aug");
    await user.keyboard("{ArrowDown}");
    expectActiveOption(month, "Sep");
    expect(month).toHaveTextContent("Aug");
    await user.keyboard("{ArrowUp}{End}");
    expectActiveOption(month, "Dec");
    await user.keyboard("{Home}{Enter}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(month).toHaveFocus();
    expect(month).toHaveTextContent("Jan");
  });

  it("opens years with ArrowUp and commits with Space", async () => {
    const user = userEvent.setup();
    render(<ControlledCalendar />);
    const year = screen.getByRole("combobox", { name: "Choose the Year" });
    year.focus();

    await user.keyboard("{ArrowUp}");
    expectActiveOption(year, "2026");
    await user.keyboard("{ArrowUp} ");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(year).toHaveFocus();
    expect(year).toHaveTextContent("2025");
  });

  it("skips disabled months and stops at the available boundaries", async () => {
    const user = userEvent.setup();
    render(
      <Calendar
        captionLayout="dropdown"
        defaultMonth={new Date(2026, 7)}
        startMonth={new Date(2026, 6)}
        endMonth={new Date(2026, 9)}
      />,
    );
    const month = screen.getByRole("combobox", { name: "Choose the Month" });
    await user.click(month);
    await user.keyboard("{Home}{ArrowUp}");
    expectActiveOption(month, "Jul");
    await user.keyboard("{End}{ArrowDown}");
    expectActiveOption(month, "Oct");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(month).toHaveTextContent("Sep");
  });

  it("uses Escape to close only the dropdown within a dialog", async () => {
    const user = userEvent.setup();
    render(
      <Dialog defaultOpen>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Choose a date</DialogTitle>
          <ControlledCalendar />
        </DialogContent>
      </Dialog>,
    );
    const month = screen.getByRole("combobox", { name: "Choose the Month" });
    await user.click(month);
    await user.keyboard("{ArrowDown}{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose a date" }))
      .toBeInTheDocument();
    expect(month).toHaveFocus();
    expect(month).toHaveTextContent("Aug");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("uses Escape to close only the dropdown within a popover", async () => {
    const user = userEvent.setup();
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Choose a date</PopoverTrigger>
        <PopoverContent aria-label="Date picker">
          <ControlledCalendar />
        </PopoverContent>
      </Popover>,
    );
    const year = screen.getByRole("combobox", { name: "Choose the Year" });
    await user.click(year);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Date picker" }))
      .toBeInTheDocument();
    expect(year).toHaveFocus();
  });

  it("tabs between month and year without traversing or committing options", async () => {
    const user = userEvent.setup();
    render(<ControlledCalendar />);
    const month = screen.getByRole("combobox", { name: "Choose the Month" });
    const year = screen.getByRole("combobox", { name: "Choose the Year" });
    await user.click(month);
    await user.keyboard("{ArrowDown}");
    await user.tab();

    expect(year).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(month).toHaveTextContent("Aug");
    await user.keyboard("{Enter}{ArrowUp}");
    await user.tab({ shift: true });
    expect(month).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(year).toHaveTextContent("2026");
  });

  it("preserves the active dropdown during a parent rerender", async () => {
    const user = userEvent.setup();
    const view = render(<ControlledCalendar />);
    const month = screen.getByRole("combobox", { name: "Choose the Month" });
    await user.click(month);
    await user.keyboard("{ArrowDown}");

    view.rerender(<ControlledCalendar label="Updated calendar" />);

    expectActiveOption(month, "Sep");
    expect(month).toHaveAttribute("aria-expanded", "true");
  });

  it("scrolls the active year into the list viewport without moving its container", async () => {
    const user = userEvent.setup();
    render(
      <div aria-label="Scrollable container">
        <ControlledCalendar />
      </div>,
    );
    const container = screen.getByLabelText("Scrollable container");
    container.scrollTop = 120;
    const year = screen.getByRole("combobox", { name: "Choose the Year" });
    await user.click(year);
    const list = screen.getByRole("listbox");
    const nextYear = screen.getByRole("option", { name: "2027" });
    Object.defineProperty(list, "clientHeight", { value: 100 });
    Object.defineProperties(nextYear, {
      offsetTop: { value: 640 },
      offsetHeight: { value: 32 },
    });

    await user.keyboard("{ArrowDown}");

    expect(list.scrollTop).toBe(572);
    expect(container.scrollTop).toBe(120);
    expectActiveOption(year, "2027");
  });

  it("reveals the selected year when the dropdown first mounts", async () => {
    const user = userEvent.setup();
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "option" &&
            this.textContent === "2026"
          ? 640
          : 0;
      });
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "option" ? 32 : 0;
      });
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "listbox" ? 100 : 0;
      });
    try {
      render(
        <div aria-label="Scrollable container">
          <ControlledCalendar />
        </div>,
      );
      const container = screen.getByLabelText("Scrollable container");
      container.scrollTop = 120;
      const year = screen.getByRole("combobox", { name: "Choose the Year" });

      await user.click(year);

      expect(screen.getByRole("listbox").scrollTop).toBe(572);
      expect(container.scrollTop).toBe(120);
      expectActiveOption(year, "2026");
    } finally {
      offsetTop.mockRestore();
      offsetHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });
});
