import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react";
import {
  DayButton,
  DayPicker,
  type DropdownProps,
  getDefaultClassNames,
  type RootProps,
} from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";

function CalendarDropdown({
  options,
  value,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: DropdownProps) {
  const [open, setOpen] = React.useState(false);
  const listboxId = React.useId();
  const selectedValue = Number(value);
  const selected = options?.find((option) => option.value === selectedValue);
  const [activeValue, setActiveValue] = React.useState(selectedValue);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const listboxRef = React.useRef<HTMLDivElement>(null);
  const activeOptionRef = React.useRef<HTMLButtonElement>(null);
  const enabledOptions = options?.filter((option) => !option.disabled) ?? [];

  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      setActiveValue(
        enabledOptions.find((option) => option.value === selectedValue)
          ?.value ??
          enabledOptions[0]?.value ?? selectedValue,
      );
    }
    setOpen(nextOpen);
  };

  const scrollActiveOptionIntoView = React.useCallback(() => {
    const list = listboxRef.current;
    const option = activeOptionRef.current;
    if (!list || !option) return;
    // Keep scrolling local: scrollIntoView can also move the enclosing dialog.
    if (option.offsetTop < list.scrollTop) {
      list.scrollTop = option.offsetTop;
    } else if (
      option.offsetTop + option.offsetHeight >
        list.scrollTop + list.clientHeight
    ) {
      list.scrollTop = option.offsetTop + option.offsetHeight -
        list.clientHeight;
    }
  }, []);

  React.useEffect(() => {
    if (open) scrollActiveOptionIntoView();
  }, [open, activeValue, scrollActiveOptionIntoView]);

  const choose = (nextValue: number) => {
    if (!enabledOptions.some((option) => option.value === nextValue)) return;
    onChange?.({
      target: { value: String(nextValue) },
      currentTarget: { value: String(nextValue) },
    } as React.ChangeEvent<HTMLSelectElement>);
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={changeOpen}>
      <div className="relative">
        <PopoverPrimitive.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            role="combobox"
            aria-label={ariaLabel}
            aria-controls={listboxId}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-activedescendant={open
              ? `${listboxId}-${activeValue}`
              : undefined}
            disabled={disabled}
            className="flex h-9 min-w-[5.25rem] items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm font-semibold text-foreground shadow-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                setOpen(false);
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (open) choose(activeValue);
                else changeOpen(true);
                return;
              }
              if (
                !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
              ) return;
              event.preventDefault();
              if (!open) {
                changeOpen(true);
                if (event.key !== "Home" && event.key !== "End") return;
              }
              const index = enabledOptions.findIndex((option) =>
                option.value === activeValue
              );
              const nextIndex = event.key === "Home"
                ? 0
                : event.key === "End"
                ? enabledOptions.length - 1
                : Math.max(
                  0,
                  Math.min(
                    enabledOptions.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
              const nextOption = enabledOptions[nextIndex];
              if (nextOption) setActiveValue(nextOption.value);
            }}
          >
            <span>{selected?.label ?? value}</span>
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Content
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          sideOffset={4}
          className="relative z-[70] max-h-56 min-w-[var(--radix-popover-trigger-width)] overflow-y-auto overscroll-contain rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus({ preventScroll: true });
            // Radix mounts Content after the opening render's effect has run.
            scrollActiveOptionIntoView();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus({ preventScroll: true });
          }}
          onWheel={(event) => event.stopPropagation()}
        >
          {options?.map((option) => (
            <button
              key={option.value}
              id={`${listboxId}-${option.value}`}
              ref={option.value === activeValue ? activeOptionRef : undefined}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={option.value === selectedValue}
              data-active={option.value === activeValue}
              disabled={option.disabled}
              className="flex w-full items-center rounded-sm px-3 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground data-[active=true]:bg-accent data-[active=true]:text-accent-foreground aria-selected:bg-primary aria-selected:text-primary-foreground disabled:pointer-events-none disabled:opacity-40"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option.value)}
            >
              {option.label}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </div>
    </PopoverPrimitive.Root>
  );
}

function CalendarRoot({ className, rootRef, ...props }: RootProps) {
  return (
    <div
      data-slot="calendar"
      ref={rootRef}
      className={cn(className)}
      {...props}
    />
  );
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = "label",
  buttonVariant = "ghost",
  formatters,
  components,
  style,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  buttonVariant?: React.ComponentProps<typeof Button>["variant"];
}) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(
        "bg-background group/calendar p-3 [--cell-size:3rem] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent",
        String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
        String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
        className,
      )}
      captionLayout={captionLayout}
      formatters={{
        formatMonthDropdown: (date) =>
          date.toLocaleString("default", { month: "short" }),
        ...formatters,
      }}
      classNames={{
        root: cn("w-fit", defaultClassNames.root),
        months: cn(
          "relative flex flex-col gap-4 md:flex-row",
          defaultClassNames.months,
        ),
        month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
        nav: cn(
          "pointer-events-none absolute inset-x-0 top-0 z-30 flex w-full items-center justify-between gap-1",
          defaultClassNames.nav,
        ),
        button_previous: cn(
          buttonVariants({ variant: buttonVariant }),
          "pointer-events-auto h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
          defaultClassNames.button_previous,
        ),
        button_next: cn(
          buttonVariants({ variant: buttonVariant }),
          "pointer-events-auto h-[--cell-size] w-[--cell-size] select-none p-0 aria-disabled:opacity-50",
          defaultClassNames.button_next,
        ),
        month_caption: cn(
          "relative z-20 flex h-[--cell-size] w-full items-center justify-center px-[--cell-size]",
          defaultClassNames.month_caption,
        ),
        dropdowns: cn(
          "flex h-[--cell-size] w-full items-center justify-center gap-1.5 text-sm font-medium",
          defaultClassNames.dropdowns,
        ),
        dropdown_root: cn(
          "has-focus:border-ring border-input shadow-xs has-focus:ring-ring/50 has-focus:ring-[3px] relative rounded-md border",
          defaultClassNames.dropdown_root,
        ),
        dropdown: cn(
          "bg-popover absolute inset-0 opacity-0",
          defaultClassNames.dropdown,
        ),
        caption_label: cn(
          "select-none font-medium",
          captionLayout === "label"
            ? "text-sm"
            : "[&>svg]:text-muted-foreground flex h-8 items-center gap-1 rounded-md pl-2 pr-1 text-sm [&>svg]:size-3.5",
          defaultClassNames.caption_label,
        ),
        table: "w-full border-collapse",
        weekdays: cn("flex", defaultClassNames.weekdays),
        weekday: cn(
          "text-muted-foreground flex-1 select-none rounded-md text-[0.8rem] font-normal",
          defaultClassNames.weekday,
        ),
        week: cn("mt-2 flex w-full", defaultClassNames.week),
        week_number_header: cn(
          "w-[--cell-size] select-none",
          defaultClassNames.week_number_header,
        ),
        week_number: cn(
          "text-muted-foreground select-none text-[0.8rem]",
          defaultClassNames.week_number,
        ),
        day: cn(
          "group/day relative aspect-square h-full w-full select-none p-0 text-center [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md",
          defaultClassNames.day,
        ),
        range_start: cn(
          "bg-accent rounded-l-md",
          defaultClassNames.range_start,
        ),
        range_middle: cn("rounded-none", defaultClassNames.range_middle),
        range_end: cn("bg-accent rounded-r-md", defaultClassNames.range_end),
        today: cn(
          "bg-accent text-accent-foreground rounded-md data-[selected=true]:rounded-none",
          defaultClassNames.today,
        ),
        outside: cn(
          "text-muted-foreground aria-selected:text-muted-foreground",
          defaultClassNames.outside,
        ),
        disabled: cn(
          "text-muted-foreground opacity-50",
          defaultClassNames.disabled,
        ),
        hidden: cn("invisible", defaultClassNames.hidden),
        ...classNames,
      }}
      components={{
        Root: CalendarRoot,
        Chevron: ({ className, orientation, ...props }) => {
          if (orientation === "left") {
            return (
              <ChevronLeftIcon className={cn("size-4", className)} {...props} />
            );
          }

          if (orientation === "right") {
            return (
              <ChevronRightIcon
                className={cn("size-4", className)}
                {...props}
              />
            );
          }

          return (
            <ChevronDownIcon className={cn("size-4", className)} {...props} />
          );
        },
        DayButton: CalendarDayButton,
        Dropdown: CalendarDropdown,
        WeekNumber: ({ children, ...props }) => {
          return (
            <td {...props}>
              <div className="flex size-[--cell-size] items-center justify-center text-center">
                {children}
              </div>
            </td>
          );
        },
        ...components,
      }}
      {...props}
      style={{
        ...style,
        "--rdp-day-width": "var(--cell-size)",
        "--rdp-day-height": "var(--cell-size)",
        "--rdp-day_button-width": "var(--cell-size)",
        "--rdp-day_button-height": "var(--cell-size)",
        "--rdp-accent-color": "var(--primary)",
        "--rdp-accent-background-color":
          "color-mix(in oklab, var(--primary) 30%, var(--background))",
        "--rdp-range_middle-background-color":
          "color-mix(in oklab, var(--primary) 30%, var(--background))",
        "--rdp-range_middle-color": "var(--foreground)",
        "--rdp-range_start-color": "var(--primary-foreground)",
        "--rdp-range_end-color": "var(--primary-foreground)",
        "--rdp-range_start-date-background-color": "var(--primary)",
        "--rdp-range_end-date-background-color": "var(--primary)",
        "--rdp-today-color": "var(--primary)",
      } as React.CSSProperties}
    />
  );
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  ...props
}: React.ComponentProps<typeof DayButton>) {
  const defaultClassNames = getDefaultClassNames();

  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString()}
      data-selected-single={modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle}
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "data-[selected-single=true]:!bg-primary data-[selected-single=true]:!text-primary-foreground data-[range-middle=true]:!bg-primary/25 data-[range-middle=true]:!text-foreground data-[range-middle=true]:hover:!bg-primary/35 data-[range-start=true]:!bg-primary data-[range-start=true]:!text-primary-foreground data-[range-end=true]:!bg-primary data-[range-end=true]:!text-primary-foreground group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-ring/50 flex aspect-square h-auto w-full min-w-[--cell-size] flex-col gap-1 font-normal leading-none data-[range-end=true]:rounded-md data-[range-middle=true]:rounded-none data-[range-start=true]:rounded-md group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:ring-[3px] [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        className,
      )}
      {...props}
    />
  );
}

export { Calendar, CalendarDayButton };
