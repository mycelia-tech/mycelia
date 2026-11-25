import AxeBuilder from "@axe-core/playwright";
import { expect, SOURCE_ID, test } from "./fixtures";

async function expectAccessible(page: import("@playwright/test").Page) {
  // Measure settled colors, not an intermediate frame of a navigation transition.
  await expect.poll(() =>
    page.evaluate(() =>
      document.getAnimations().filter((animation) =>
        animation.playState === "running" &&
        animation.effect?.getTiming().iterations !== Infinity
      ).length
    )
  ).toBe(0);
  const result = await new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21aa",
  ]).analyze();
  expect(
    result.violations.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test(
  "search preserves its URL, results, and reading position after opening a source",
  async ({ page, backend }, testInfo) => {
    await page.goto("/search");
    await page.getByLabel("Question or phrase").fill("harbor picnic");
    await page.getByText("Filters", { exact: true }).click();
    await page.getByLabel("Exact platforms").fill("mycelia");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Harbor picnic recording 1",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page).toHaveURL(/q=harbor\+picnic.*platforms=mycelia/);
    await expect(page.getByText("Search diagnostics").locator("..")).not
      .toHaveAttribute("open");
    await expect(
      page.getByText("source: fictional-transcript-0", { exact: true }),
    ).not.toBeVisible();
    await expectAccessible(page);
    const sourceLink = page.getByRole("link", {
      name: "Open source",
      exact: true,
    }).nth(4);
    await sourceLink.scrollIntoViewIfNeeded();
    const position = await page.evaluate(() => window.scrollY);
    expect(position).toBeGreaterThan(300);
    await sourceLink.click();
    await expect(page).toHaveURL(
      new RegExp(`/audio/source_files/${SOURCE_ID}$`),
    );
    await expect(page.getByRole("heading", { name: "Source File Details" }))
      .toBeVisible();
    await page.goBack();
    await expect(page.getByLabel("Question or phrase")).toHaveValue(
      "harbor picnic",
    );
    await expect(page.getByLabel("Exact platforms")).toHaveValue("mycelia");
    await expect(page.getByTestId("rag-search-result")).toHaveCount(10);
    await expect.poll(async () =>
      Math.abs(await page.evaluate(() => window.scrollY) - position)
    ).toBeLessThan(5);
    expect(
      backend.requests.filter((item) =>
        item.resource === "rag" && item.body.action === "search"
      ),
    ).toHaveLength(1);
    await page.screenshot({
      path: testInfo.outputPath("search-restored.png"),
      fullPage: true,
    });
  },
);

test(
  "Messenger distinguishes a server failure from an empty archive and retries",
  async ({ page, backend }, testInfo) => {
    backend.chatUnavailable = true;
    await page.goto("/messaging");
    await expect(page.getByRole("alert")).toContainText(
      "Fictional server outage",
    );
    await expect(page.getByText("No chats found")).toHaveCount(0);
    backend.chatUnavailable = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("No chats found")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("messenger-recovered.png"),
      fullPage: true,
    });
  },
);

for (const width of [360, 768, 1440]) {
  test(
    `settings and shell remain usable by keyboard at ${width}px`,
    async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto("/settings");
      await expect(
        page.getByRole("heading", { name: "Appearance", exact: true }),
      ).toBeVisible();
      await expect.poll(() =>
        page.evaluate(() =>
          document.documentElement.scrollWidth - window.innerWidth
        )
      ).toBeLessThanOrEqual(1);
      await expectAccessible(page);
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to content" }))
        .toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("#main-content")).toBeFocused();
      if (width < 1280) {
        const menu = page.getByRole("button", { name: "Menu", exact: true });
        await menu.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("navigation", { name: "Main navigation" }))
          .toBeVisible();
        await page.getByRole("navigation", { name: "Main navigation" })
          .getByRole("link", { name: "Settings", exact: true }).focus();
        await page.keyboard.press("Escape");
        await expect(menu).toBeFocused();
        await expect(menu).toHaveAttribute("aria-expanded", "false");
      }
      if (width < 768) {
        await page.getByRole("combobox", { name: "Settings section" })
          .selectOption("/settings/workers");
      } else {
        await page.getByRole("navigation", { name: "Settings navigation" })
          .getByRole("link", { name: /Workers/ }).click();
      }
      await expect(page.getByRole("heading", { name: "Workers", exact: true }))
        .toBeVisible();
      await expect.poll(() =>
        page.evaluate(() =>
          document.documentElement.scrollWidth - window.innerWidth
        )
      ).toBeLessThanOrEqual(1);
      if (width === 1440) {
        await expect(
          page.getByRole("navigation", { name: "Main navigation" }).getByRole(
            "link",
            { name: "Settings", exact: true },
          ),
        ).toHaveAttribute("aria-current", "page");
      }
      await expectAccessible(page);
      await page.screenshot({
        path: testInfo.outputPath(`settings-${width}.png`),
        fullPage: true,
      });
    },
  );
}

test(
  "a failed lazy page renders recovery actions and keeps home navigation available",
  async ({ page }, testInfo) => {
    await page.route(
      "**/src/pages/settings/WorkersPage.tsx*",
      (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body:
            'throw new Error("Fictional lazy-page failure"); export default function Page() {}',
        }),
    );
    await page.goto("/settings/workers");
    await expect(
      page.getByRole("heading", { name: "This page could not be loaded" }),
    ).toBeVisible();
    await expect(page.getByText("Technical details").locator("..")).not
      .toHaveAttribute("open");
    await expect(page.getByRole("button", { name: "Reload page" }))
      .toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("route-error.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.getByRole("heading", { name: "Welcome to Mycelia" }))
      .toBeVisible();
  },
);

test("home search opens matching archive results on a phone in dark mode", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const search = page.getByRole("search");
  await expect(search).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  await page.screenshot({ path: testInfo.outputPath("home-mobile.png") });
  await search.getByRole("searchbox").fill("harbor picnic");
  await search.getByRole("button", { name: "Search memories" }).click();
  await expect(page).toHaveURL(/\/search\?q=harbor\+picnic/);
  await expect(page.getByRole("heading", { name: "Harbor picnic recording 1", exact: true })).toBeVisible();
});
