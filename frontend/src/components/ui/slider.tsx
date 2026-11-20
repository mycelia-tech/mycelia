import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils.ts";

type SliderProps =
  & React.ComponentPropsWithoutRef<
    typeof SliderPrimitive.Root
  >
  & {
    thumbLabels?: string[];
    thumbValueTexts?: string[];
    rangeClassName?: string;
  };

const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  SliderProps
>((
  { className, rangeClassName, thumbLabels, thumbValueTexts, ...props },
  ref,
) => {
  const thumbCount = props.value?.length ?? props.defaultValue?.length ?? 1;
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        "relative flex w-full touch-none select-none items-center",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
        <SliderPrimitive.Range
          className={cn("absolute h-full bg-primary", rangeClassName)}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: thumbCount }, (_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          aria-label={thumbLabels?.[index]}
          aria-valuetext={thumbValueTexts?.[index]}
          className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
