import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export interface AnimationConfig {
  popoverAnimation?: "scale" | "slide" | "fade" | "flip" | "none";
  optionHoverAnimation?: "highlight" | "scale" | "glow" | "none";
  duration?: number;
  delay?: number;
}

const selectVariants = cva("transition-all duration-300 ease-in-out", {
  variants: {
    variant: {
      default: "border-foreground/10 text-foreground bg-card hover:bg-card/80",
      secondary:
        "border-foreground/10 bg-secondary text-secondary-foreground hover:bg-secondary/80",
      destructive:
        "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
      inverted: "inverted",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface SelectOption {
  label: string;
  value: string;
  icon?: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
}

export interface SelectGroup {
  heading: string;
  options: SelectOption[];
}

export interface SearchableSelectSingleProps extends
  Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    "animationConfig" | "onChange"
  >,
  VariantProps<typeof selectVariants> {
  options: SelectOption[] | SelectGroup[];
  onValueChange: (value: string | undefined) => void;
  onSearchChange?: (searchValue: string) => void;
  defaultValue?: string;
  placeholder?: string;
  animation?: number;
  animationConfig?: AnimationConfig;
  modalPopover?: boolean;
  asChild?: boolean;
  className?: string;
  searchable?: boolean;
  emptyIndicator?: React.ReactNode | ((searchValue: string) => React.ReactNode);
  autoSize?: boolean;
  popoverClassName?: string;
  disabled?: boolean;
  responsive?:
    | boolean
    | {
      mobile?: {
        hideIcon?: boolean;
        compactMode?: boolean;
      };
      tablet?: {
        hideIcon?: boolean;
        compactMode?: boolean;
      };
      desktop?: {
        hideIcon?: boolean;
        compactMode?: boolean;
      };
    };
  minWidth?: string;
  maxWidth?: string;
  deduplicateOptions?: boolean;
  resetOnDefaultValueChange?: boolean;
  allowClear?: boolean;
}

export interface SearchableSelectSingleRef {
  reset: () => void;
  getSelectedValue: () => string | undefined;
  setSelectedValue: (value: string | undefined) => void;
  clear: () => void;
  focus: () => void;
}

export const SearchableSelectSingle = React.forwardRef<
  SearchableSelectSingleRef,
  SearchableSelectSingleProps
>(
  (
    {
      options,
      onValueChange,
      onSearchChange,
      variant,
      defaultValue,
      placeholder = "Select option",
      animation = 0,
      animationConfig,
      modalPopover = false,
      asChild = false,
      className,
      searchable = true,
      emptyIndicator,
      autoSize = false,
      popoverClassName,
      disabled = false,
      responsive,
      minWidth,
      maxWidth,
      deduplicateOptions = false,
      resetOnDefaultValueChange = true,
      allowClear = true,
      ...props
    },
    ref,
  ) => {
    const [selectedValue, setSelectedValue] = React.useState<
      string | undefined
    >(defaultValue);
    const [isPopoverOpen, setIsPopoverOpen] = React.useState(false);
    const [searchValue, setSearchValue] = React.useState("");

    const [politeMessage, setPoliteMessage] = React.useState("");
    const [assertiveMessage, setAssertiveMessage] = React.useState("");
    const prevIsOpen = React.useRef(isPopoverOpen);
    const prevSearchValue = React.useRef(searchValue);

    const announce = React.useCallback(
      (message: string, priority: "polite" | "assertive" = "polite") => {
        if (priority === "assertive") {
          setAssertiveMessage(message);
          setTimeout(() => setAssertiveMessage(""), 100);
        } else {
          setPoliteMessage(message);
          setTimeout(() => setPoliteMessage(""), 100);
        }
      },
      [],
    );

    const selectId = React.useId();
    const listboxId = `${selectId}-listbox`;
    const triggerDescriptionId = `${selectId}-description`;
    const selectedLabelId = `${selectId}-label`;

    const prevDefaultValueRef = React.useRef<string | undefined>(defaultValue);

    const isGroupedOptions = React.useCallback(
      (
        opts: SelectOption[] | SelectGroup[],
      ): opts is SelectGroup[] => {
        return opts.length > 0 && "heading" in opts[0];
      },
      [],
    );

    const resetToDefault = React.useCallback(() => {
      setSelectedValue(defaultValue);
      setIsPopoverOpen(false);
      setSearchValue("");
      onValueChange(defaultValue);
    }, [defaultValue, onValueChange]);

    const buttonRef = React.useRef<HTMLButtonElement>(null);

    React.useImperativeHandle(
      ref,
      () => ({
        reset: resetToDefault,
        getSelectedValue: () => selectedValue,
        setSelectedValue: (value: string | undefined) => {
          setSelectedValue(value);
          onValueChange(value);
        },
        clear: () => {
          setSelectedValue(undefined);
          onValueChange(undefined);
        },
        focus: () => {
          if (buttonRef.current) {
            buttonRef.current.focus();
            const originalOutline = buttonRef.current.style.outline;
            const originalOutlineOffset = buttonRef.current.style.outlineOffset;
            buttonRef.current.style.outline = "2px solid var(--ring)";
            buttonRef.current.style.outlineOffset = "2px";
            setTimeout(() => {
              if (buttonRef.current) {
                buttonRef.current.style.outline = originalOutline;
                buttonRef.current.style.outlineOffset = originalOutlineOffset;
              }
            }, 1000);
          }
        },
      }),
      [resetToDefault, selectedValue, onValueChange],
    );

    const [screenSize, setScreenSize] = React.useState<
      "mobile" | "tablet" | "desktop"
    >("desktop");

    React.useEffect(() => {
      if (typeof window === "undefined") return;
      const handleResize = () => {
        const width = window.innerWidth;
        if (width < 640) {
          setScreenSize("mobile");
        } else if (width < 1024) {
          setScreenSize("tablet");
        } else {
          setScreenSize("desktop");
        }
      };
      handleResize();
      globalThis.addEventListener("resize", handleResize);
      return () => {
        if (typeof window !== "undefined") {
          globalThis.removeEventListener("resize", handleResize);
        }
      };
    }, []);

    const getResponsiveSettings = () => {
      if (!responsive) {
        return {
          hideIcon: false,
          compactMode: false,
        };
      }
      if (responsive === true) {
        const defaultResponsive = {
          mobile: { hideIcon: false, compactMode: true },
          tablet: { hideIcon: false, compactMode: false },
          desktop: { hideIcon: false, compactMode: false },
        };
        const currentSettings = defaultResponsive[screenSize];
        return {
          hideIcon: currentSettings?.hideIcon ?? false,
          compactMode: currentSettings?.compactMode ?? false,
        };
      }
      const currentSettings = responsive[screenSize];
      return {
        hideIcon: currentSettings?.hideIcon ?? false,
        compactMode: currentSettings?.compactMode ?? false,
      };
    };

    const responsiveSettings = getResponsiveSettings();

    const getPopoverAnimationClass = () => {
      if (animationConfig?.popoverAnimation) {
        switch (animationConfig.popoverAnimation) {
          case "scale":
            return "animate-scaleIn";
          case "slide":
            return "animate-slideInDown";
          case "fade":
            return "animate-fadeIn";
          case "flip":
            return "animate-flipIn";
          case "none":
            return "";
          default:
            return "";
        }
      }
      return "";
    };

    const getAllOptions = React.useCallback((): SelectOption[] => {
      if (options.length === 0) return [];
      let allOptions: SelectOption[];
      if (isGroupedOptions(options)) {
        allOptions = options.flatMap((group) => group.options);
      } else {
        allOptions = options;
      }
      const valueSet = new Set<string>();
      const duplicates: string[] = [];
      const uniqueOptions: SelectOption[] = [];
      allOptions.forEach((option) => {
        if (valueSet.has(option.value)) {
          duplicates.push(option.value);
          if (!deduplicateOptions) {
            uniqueOptions.push(option);
          }
        } else {
          valueSet.add(option.value);
          uniqueOptions.push(option);
        }
      });
      if (import.meta.env.DEV && duplicates.length > 0) {
        const action = deduplicateOptions
          ? "automatically removed"
          : "detected";
        console.warn(
          `SearchableSelectSingle: Duplicate option values ${action}: ${
            duplicates.join(
              ", ",
            )
          }. ` +
            `${
              deduplicateOptions
                ? "Duplicates have been removed automatically."
                : "This may cause unexpected behavior. Consider setting 'deduplicateOptions={true}' or ensure all option values are unique."
            }`,
        );
      }
      return deduplicateOptions ? uniqueOptions : allOptions;
    }, [options, deduplicateOptions, isGroupedOptions]);

    const getOptionByValue = React.useCallback(
      (value: string): SelectOption | undefined => {
        const allOptions = getAllOptions();
        const option = allOptions.find((option) => option.value === value);
        // Only warn if options have been loaded (not empty) and value is still not found
        // This prevents spamming warnings during initial load when options haven't loaded yet
        if (!option && value && allOptions.length > 0 && import.meta.env.DEV) {
          console.warn(
            `SearchableSelectSingle: Option with value "${value}" not found in options list`,
          );
        }
        return option;
      },
      [getAllOptions],
    );

    const filteredOptions = React.useMemo(() => {
      if (!searchable || !searchValue) return options;
      if (options.length === 0) return [];
      if (isGroupedOptions(options)) {
        return options
          .map((group) => ({
            ...group,
            options: group.options.filter(
              (option) =>
                option.label
                  .toLowerCase()
                  .includes(searchValue.toLowerCase()) ||
                option.value.toLowerCase().includes(searchValue.toLowerCase()),
            ),
          }))
          .filter((group) => group.options.length > 0);
      }
      return options.filter(
        (option) =>
          option.label.toLowerCase().includes(searchValue.toLowerCase()) ||
          option.value.toLowerCase().includes(searchValue.toLowerCase()),
      );
    }, [options, searchValue, searchable, isGroupedOptions]);

    const handleInputKeyDown = (
      event: React.KeyboardEvent<HTMLInputElement>,
    ) => {
      if (event.key === "Enter") {
        setIsPopoverOpen(true);
      } else if (
        event.key === "Backspace" && !event.currentTarget.value && allowClear
      ) {
        setSelectedValue(undefined);
        onValueChange(undefined);
      }
    };

    const selectOption = (optionValue: string) => {
      if (disabled) return;
      const option = getOptionByValue(optionValue);
      if (option?.disabled) return;
      setSelectedValue(optionValue);
      onValueChange(optionValue);
      setIsPopoverOpen(false);
      announce(`${option?.label} selected.`);
    };

    const handleClear = () => {
      if (disabled || !allowClear) return;
      setSelectedValue(undefined);
      onValueChange(undefined);
      announce("Selection cleared.");
    };

    const handleTogglePopover = () => {
      if (disabled) return;
      setIsPopoverOpen((prev) => !prev);
    };

    React.useEffect(() => {
      if (!resetOnDefaultValueChange) return;
      const prevDefaultValue = prevDefaultValueRef.current;
      if (prevDefaultValue !== defaultValue) {
        if (selectedValue !== defaultValue) {
          setSelectedValue(defaultValue);
        }
        prevDefaultValueRef.current = defaultValue;
      }
    }, [defaultValue, selectedValue, resetOnDefaultValueChange]);

    const getWidthConstraints = () => {
      const defaultMinWidth = screenSize === "mobile" ? "0px" : "200px";
      const effectiveMinWidth = minWidth || defaultMinWidth;
      const effectiveMaxWidth = maxWidth || "100%";
      return {
        minWidth: effectiveMinWidth,
        maxWidth: effectiveMaxWidth,
        width: autoSize ? "auto" : "100%",
      };
    };

    const widthConstraints = getWidthConstraints();

    React.useEffect(() => {
      if (!isPopoverOpen) {
        setSearchValue("");
      }
    }, [isPopoverOpen]);

    React.useEffect(() => {
      onSearchChange?.(searchValue);
    }, [searchValue, onSearchChange]);

    React.useEffect(() => {
      const allOptions = getAllOptions();
      const totalOptions = allOptions.filter((opt) => !opt.disabled).length;

      if (isPopoverOpen !== prevIsOpen.current) {
        if (isPopoverOpen) {
          announce(
            `Dropdown opened. ${totalOptions} options available. Use arrow keys to navigate.`,
          );
        } else {
          announce("Dropdown closed.");
        }
        prevIsOpen.current = isPopoverOpen;
      }

      if (
        searchValue !== prevSearchValue.current &&
        searchValue !== undefined
      ) {
        if (searchValue && isPopoverOpen) {
          const filteredCount = allOptions.filter(
            (opt) =>
              opt.label.toLowerCase().includes(searchValue.toLowerCase()) ||
              opt.value.toLowerCase().includes(searchValue.toLowerCase()),
          ).length;

          announce(
            `${filteredCount} option${
              filteredCount === 1 ? "" : "s"
            } found for "${searchValue}"`,
          );
        }
        prevSearchValue.current = searchValue;
      }
    }, [isPopoverOpen, searchValue, announce, getAllOptions]);

    const selectedOption = selectedValue
      ? getOptionByValue(selectedValue)
      : undefined;

    return (
      <>
        <div className="sr-only">
          <div aria-live="polite" aria-atomic="true" role="status">
            {politeMessage}
          </div>
          <div aria-live="assertive" aria-atomic="true" role="alert">
            {assertiveMessage}
          </div>
        </div>

        <Popover
          open={isPopoverOpen}
          onOpenChange={setIsPopoverOpen}
          modal={modalPopover}
        >
          <div id={triggerDescriptionId} className="sr-only">
            Select dropdown. Use arrow keys to navigate, Enter to select, and
            Escape to close.
          </div>
          <div id={selectedLabelId} className="sr-only" aria-live="polite">
            {selectedOption
              ? `Selected: ${selectedOption.label}`
              : "No option selected"}
          </div>

          <PopoverTrigger asChild>
            <Button
              ref={buttonRef}
              {...props}
              onClick={handleTogglePopover}
              disabled={disabled}
              role="combobox"
              aria-expanded={isPopoverOpen}
              aria-haspopup="listbox"
              aria-controls={isPopoverOpen ? listboxId : undefined}
              aria-describedby={`${triggerDescriptionId} ${selectedLabelId}`}
              aria-label={`Select: ${selectedOption?.label || placeholder}`}
              className={cn(
                "flex px-3 py-2 rounded-md border h-8 items-center justify-between bg-inherit hover:bg-inherit [&_svg]:pointer-events-auto",
                autoSize ? "w-auto" : "w-full",
                disabled && "opacity-50 cursor-not-allowed",
                className,
              )}
              style={{
                ...widthConstraints,
                maxWidth: `min(${widthConstraints.maxWidth}, 100%)`,
              }}
            >
              {selectedOption
                ? (
                  <div className="flex items-center w-full">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {selectedOption.icon && !responsiveSettings.hideIcon && (
                        <selectedOption.icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className="text-foreground flex-1 min-w-0 truncate">
                        {selectedOption.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {allowClear && (
                        <>
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleClear();
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                event.stopPropagation();
                                handleClear();
                              }
                            }}
                            aria-label="Clear selection"
                            className="flex items-center justify-center h-4 w-4 cursor-pointer text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 rounded-sm flex-shrink-0"
                          >
                            <XIcon className="h-4 w-4" />
                          </div>
                          <Separator
                            orientation="vertical"
                            className="h-4 flex-shrink-0"
                          />
                        </>
                      )}
                      <ChevronDown
                        className="h-4 cursor-pointer text-muted-foreground flex-shrink-0"
                        aria-hidden="true"
                      />
                    </div>
                  </div>
                )
                : (
                  <div className="flex items-center w-full">
                    <span className="text-sm text-muted-foreground flex-1 min-w-0 truncate">
                      {placeholder}
                    </span>
                    <ChevronDown className="h-4 cursor-pointer text-muted-foreground flex-shrink-0" />
                  </div>
                )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            id={listboxId}
            role="listbox"
            aria-label="Available options"
            className={cn(
              "w-auto p-0",
              getPopoverAnimationClass(),
              screenSize === "mobile" && "w-[85vw] max-w-[280px]",
              screenSize === "tablet" && "w-[70vw] max-w-md",
              screenSize === "desktop" && "min-w-[300px]",
              popoverClassName,
            )}
            style={{
              animationDuration: `${animationConfig?.duration || animation}s`,
              animationDelay: `${animationConfig?.delay || 0}s`,
              maxWidth: `min(${widthConstraints.maxWidth}, 85vw)`,
              maxHeight: screenSize === "mobile" ? "70vh" : "60vh",
              touchAction: "manipulation",
            }}
            align="start"
            onEscapeKeyDown={() => setIsPopoverOpen(false)}
          >
            <Command>
              {searchable && (
                <CommandInput
                  placeholder="Search options..."
                  onKeyDown={handleInputKeyDown}
                  value={searchValue}
                  onValueChange={setSearchValue}
                  aria-label="Search through available options"
                  aria-describedby={`${selectId}-search-help`}
                />
              )}
              {searchable && (
                <div id={`${selectId}-search-help`} className="sr-only">
                  Type to filter options. Use arrow keys to navigate results.
                </div>
              )}
              <CommandList
                className={cn(
                  "max-h-[40vh] overflow-y-auto",
                  screenSize === "mobile" && "max-h-[50vh]",
                  "overscroll-behavior-y-contain",
                )}
              >
                <CommandEmpty>
                  {typeof emptyIndicator === "function"
                    ? emptyIndicator(searchValue)
                    : emptyIndicator || "No results found."}
                </CommandEmpty>
                {isGroupedOptions(filteredOptions)
                  ? (
                    filteredOptions.map((group) => (
                      <CommandGroup key={group.heading} heading={group.heading}>
                        {group.options.map((option) => {
                          const isSelected = selectedValue === option.value;
                          return (
                            <CommandItem
                              key={option.value}
                              onSelect={() => selectOption(option.value)}
                              role="option"
                              aria-selected={isSelected}
                              aria-disabled={option.disabled}
                              aria-label={`${option.label}${
                                isSelected ? ", selected" : ", not selected"
                              }${option.disabled ? ", disabled" : ""}`}
                              className={cn(
                                "cursor-pointer transition-colors",
                                isSelected &&
                                  "bg-accent text-accent-foreground",
                                option.disabled &&
                                  "opacity-50 cursor-not-allowed",
                              )}
                              disabled={option.disabled}
                            >
                              {option.icon && (
                                <option.icon
                                  className="mr-2 h-4 w-4 text-muted-foreground"
                                  aria-hidden="true"
                                />
                              )}
                              <span>{option.label}</span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    ))
                  )
                  : (
                    <CommandGroup>
                      {filteredOptions.map((option) => {
                        const isSelected = selectedValue === option.value;
                        return (
                          <CommandItem
                            key={option.value}
                            onSelect={() => selectOption(option.value)}
                            role="option"
                            aria-selected={isSelected}
                            aria-disabled={option.disabled}
                            aria-label={`${option.label}${
                              isSelected ? ", selected" : ", not selected"
                            }${option.disabled ? ", disabled" : ""}`}
                            className={cn(
                              "cursor-pointer transition-colors",
                              isSelected && "bg-accent text-accent-foreground",
                              option.disabled &&
                                "opacity-50 cursor-not-allowed",
                            )}
                            disabled={option.disabled}
                          >
                            {option.icon && (
                              <option.icon
                                className="mr-2 h-4 w-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                            )}
                            <span>{option.label}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => setIsPopoverOpen(false)}
                    className="justify-center cursor-pointer"
                  >
                    Close
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </>
    );
  },
);

SearchableSelectSingle.displayName = "SearchableSelectSingle";
