import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RouteError } from "./RouteError";

describe("Route error recovery", () => {
  it("keeps navigation available with details collapsed when a page fails", async () => {
    const router = createMemoryRouter([{
      id: "root",
      path: "/",
      element: <p>Loaded</p>,
      errorElement: <RouteError />,
    }], {
      hydrationData: { errors: { root: new Error("Synthetic load failure") } },
    });
    render(<RouterProvider router={router} />);
    expect(
      await screen.findByRole("heading", {
        name: "This page could not be loaded",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(screen.getByText("Technical details").closest("details")).not
      .toHaveAttribute("open");
  });
});
