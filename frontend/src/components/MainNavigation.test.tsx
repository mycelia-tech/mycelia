import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { MainNavigation } from "./MainNavigation";

describe("Main navigation", () => {
  it.each([["/objects/abc", "Objects"], ["/jobs/abc", "Jobs"], [
    "/settings/workers/ingestion",
    "Settings",
  ]])("keeps the parent active at %s", (path, label) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <MainNavigation runningCount={3} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: new RegExp(label) }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("navigation", { name: "Main navigation" }))
      .toBeInTheDocument();
  });
  it("does not treat a similarly prefixed path as an active section", () => {
    render(
      <MemoryRouter initialEntries={["/objects-other"]}>
        <MainNavigation />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Objects" })).not.toHaveAttribute(
      "aria-current",
    );
  });
});
