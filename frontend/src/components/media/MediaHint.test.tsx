import { render, screen } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MediaHint } from "./MediaHint";

const userEvent = (userEventLib as any).default || userEventLib;

describe("MediaHint", () => {
  it("keeps supporting copy out of the layout and reveals it on hover", async () => {
    const user = userEvent.setup();
    render(
      <MediaHint label="About this action">
        Supporting explanation
      </MediaHint>,
    );

    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(screen.getByRole("button", { name: "About this action" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Supporting explanation",
    );
  });
});
