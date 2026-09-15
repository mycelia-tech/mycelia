import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as userEventLib from "@testing-library/user-event";
import * as api from "@/lib/api";
import GoogleCloudSettingsPage from "./GoogleCloudSettingsPage";

const userEvent = (userEventLib as any).default || userEventLib;

vi.mock("@/lib/api", () => ({ callResource: vi.fn() }));

const mockCallResource = vi.mocked(api.callResource);

const emptyConfig = {
  enabled: false,
  profiles: [],
  promoGuard: {
    mode: "promo_guarded",
    stopBeforeHours: 72,
    monthlyGrossLimitUsd: 1,
    dailyGrossLimitUsd: 0.1,
    perImportGrossLimitUsd: 0.01,
  },
  limits: {
    maxFilesPerImport: 200,
    maxImageBytes: 20_000_000,
    maxPdfBytes: 32_000_000,
    maxPdfPages: 15,
  },
  eventAggregation: {
    maxGapMinutes: 240,
    maxDistanceKm: 25,
    linkWindowMinutes: 90,
    maxAssetsPerEvent: 50,
    maxPreviewsPerAnalysis: 8,
    perEventGrossLimitUsd: 0.02,
  },
};

const status = {
  enabled: false,
  sourceConfigured: true,
  adc: { configured: true, credentialPathConfigured: true },
  promoGuard: { ...emptyConfig.promoGuard, creditVerificationFresh: false },
  usage: {
    month: "2026-08",
    day: "2026-08-21",
    grossCommittedUsd: 0.006,
    grossReservedUsd: 0.0015,
    grossMonthUsd: 0.0075,
    grossTodayUsd: 0.0075,
    monthlyLimitUsd: 1,
    dailyLimitUsd: 0.1,
    monthlyRemainingUsd: 0.9925,
    dailyRemainingUsd: 0.0925,
  },
  connectorTestEstimateUsd: {
    vertexAndVision: 0.0075,
    withDocumentAi: 0.009,
  },
};

describe("GoogleCloudSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCallResource.mockImplementation((resource, input) => {
      if (resource === "config" && input.action === "get") {
        return Promise.resolve(emptyConfig);
      }
      if (resource === "media" && input.action === "status") {
        return Promise.resolve(status);
      }
      return Promise.resolve({});
    });
  });

  it("creates an EU ADC preset without exposing an API-key field", async () => {
    const user = userEvent.setup();
    render(<GoogleCloudSettingsPage />);

    await user.click(
      await screen.findByRole("button", { name: "Add Google Cloud preset" }),
    );

    expect(screen.getAllByText("Google Cloud EU Photo Knowledge").length)
      .toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Vertex endpoint:/).textContent).toContain("eu");
    expect(screen.getByText(/visual model:/).textContent).toContain(
      "gemini-3.5-flash-lite",
    );
    expect(screen.queryByLabelText(/API key/i)).toBeNull();

    await user.type(
      screen.getByLabelText("Google project ID"),
      "mycelia-media-260821",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("config", {
        action: "patch",
        path: "mediaKnowledge",
        updates: expect.objectContaining({
          activeProfileId: undefined,
          profiles: [expect.objectContaining({
            providerType: "google-cloud",
            projectId: "mycelia-media-260821",
            location: "eu",
            enabled: false,
          })],
        }),
      });
    });
  });

  it("shows the conservative committed and reserved usage ledger", async () => {
    render(<GoogleCloudSettingsPage />);

    expect(await screen.findByText("$0.0075 / $1.00")).toBeTruthy();
    expect(screen.getByText("Committed")).toBeTruthy();
    expect(screen.getByText("$0.0060")).toBeTruthy();
    expect(screen.getByText("Reserved")).toBeTruthy();
    expect(screen.getByText("$0.0015")).toBeTruthy();
  });

  it("saves an explicit disabled daily limit and reloads it without changing other caps", async () => {
    let stored: any = structuredClone(emptyConfig);
    mockCallResource.mockImplementation((resource, input) => {
      if (resource === "config") {
        if (input.action === "patch") stored = input.updates;
        return Promise.resolve(stored);
      }
      return Promise.resolve({
        ...status,
        usage: {
          ...status.usage,
          dailyLimitUsd: stored.promoGuard.dailyGrossLimitUsd,
          dailyRemainingUsd: stored.promoGuard.dailyGrossLimitUsd === null
            ? null
            : status.usage.dailyRemainingUsd,
        },
      });
    });
    const user = userEvent.setup();
    render(<GoogleCloudSettingsPage />);
    const toggle = await screen.findByRole("switch", { name: "Daily limit" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    expect(screen.queryByLabelText("Daily stop, USD")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("$0.0075 / No daily limit");
    expect(stored.promoGuard).toEqual({
      ...emptyConfig.promoGuard,
      dailyGrossLimitUsd: null,
    });
    expect(stored.eventAggregation).toEqual(emptyConfig.eventAggregation);

    await user.click(screen.getByRole("switch", { name: "Daily limit" }));
    expect((screen.getByLabelText("Daily stop, USD") as HTMLInputElement).value)
      .toBe("0.1");
  });

  it("persists local clustering and per-event provider limits", async () => {
    const user = userEvent.setup();
    render(<GoogleCloudSettingsPage />);

    const gap = await screen.findByLabelText("Default gap, minutes");
    await user.clear(gap);
    await user.type(gap, "180");
    const eventStop = screen.getByLabelText("Per event gross stop, USD");
    await user.clear(eventStop);
    await user.type(eventStop, "0.015");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("config", {
        action: "patch",
        path: "mediaKnowledge",
        updates: expect.objectContaining({
          eventAggregation: expect.objectContaining({
            maxGapMinutes: 180,
            perEventGrossLimitUsd: 0.015,
          }),
        }),
      });
    });
  });

  it("discloses that the Google connector smoke uses Vertex and Vision", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      if (resource === "config" && input.action === "get") {
        return Promise.resolve({
          ...emptyConfig,
          activeProfileId: "google-cloud-media",
          profiles: [{
            id: "google-cloud-media",
            name: "Google Cloud EU Photo Knowledge",
            providerType: "google-cloud",
            enabled: true,
            concurrency: 1,
            projectId: "mycelia-media-260821",
            location: "eu",
            vertexModel: "gemini-3.5-flash-lite",
            embeddingModel: "gemini-embedding-001",
            documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07",
            allowGlobalPhotoAnalysis: false,
          }],
        });
      }
      if (resource === "media" && input.action === "status") {
        return Promise.resolve(status);
      }
      return Promise.resolve({});
    });

    render(<GoogleCloudSettingsPage />);

    expect(
      await screen.findByRole("button", { name: "Test Vertex + Vision OCR" }),
    ).toBeTruthy();
    expect(screen.getByText(/reserves at most \$0\.0075/)).toBeTruthy();
    expect(screen.getByText(/No user photo is used/)).toBeTruthy();
  });

  it("requires and stores an explicit billing-account attestation", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      if (resource === "config" && input.action === "get") {
        return Promise.resolve({
          ...emptyConfig,
          promoGuard: {
            ...emptyConfig.promoGuard,
            promotionExpiresAt: "2099-09-24T00:00:00.000Z",
          },
          activeProfileId: "google-cloud-media",
          profiles: [{
            id: "google-cloud-media",
            name: "Google Cloud EU Photo Knowledge",
            providerType: "google-cloud",
            enabled: true,
            concurrency: 1,
            projectId: "mycelia-media-260821",
            location: "eu",
            vertexModel: "gemini-3.5-flash-lite",
            embeddingModel: "gemini-embedding-001",
            documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07",
            allowGlobalPhotoAnalysis: false,
          }],
        });
      }
      if (resource === "media" && input.action === "status") {
        return Promise.resolve({
          ...status,
          promoGuard: {
            ...status.promoGuard,
            creditVerificationError: "PROMO_ACCOUNT_TYPE_NOT_VERIFIED",
          },
        });
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<GoogleCloudSettingsPage />);

    expect(
      await screen.findByText(/PROMO_ACCOUNT_TYPE_NOT_VERIFIED/),
    ).toBeTruthy();
    await user.selectOptions(
      screen.getByLabelText("Billing Overview account type"),
      "paid_with_promo",
    );
    await user.type(
      screen.getByLabelText("Remaining promotional credit, USD"),
      "300",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Confirm paid usage for this project",
      }),
    );

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("config", {
        action: "patch",
        path: "mediaKnowledge",
        updates: expect.objectContaining({
          promoGuard: expect.objectContaining({
            creditVerifiedProjectId: "mycelia-media-260821",
            verifiedRemainingUsd: 300,
            verifiedBillingAccountType: "paid_with_promo",
            creditVerifiedBillingAccountType: "paid_with_promo",
            creditVerifiedPromotionExpiresAt: "2099-09-24T00:00:00.000Z",
          }),
        }),
      });
    });
  });

  it("persists the explicit Google-call block after a previous attestation", async () => {
    mockCallResource.mockImplementation((resource, input) => {
      if (resource === "config" && input.action === "get") {
        return Promise.resolve({
          ...emptyConfig,
          promoGuard: {
            ...emptyConfig.promoGuard,
            promotionExpiresAt: "2099-09-24T00:00:00.000Z",
            creditVerifiedAt: "2099-08-21T11:00:00.000Z",
            creditVerifiedProjectId: "mycelia-media-260821",
            verifiedRemainingUsd: 300,
            verifiedBillingAccountType: "paid_with_promo",
            creditVerifiedBillingAccountType: "paid_with_promo",
            creditVerifiedPromotionExpiresAt: "2099-09-24T00:00:00.000Z",
          },
          activeProfileId: "google-cloud-media",
          profiles: [{
            id: "google-cloud-media",
            name: "Google Cloud EU Photo Knowledge",
            providerType: "google-cloud",
            enabled: true,
            concurrency: 1,
            projectId: "mycelia-media-260821",
            location: "eu",
            vertexModel: "gemini-3.5-flash-lite",
            embeddingModel: "gemini-embedding-001",
            documentAiProcessorVersion: "pretrained-ocr-v2.1-2024-08-07",
            allowGlobalPhotoAnalysis: false,
          }],
        });
      }
      if (resource === "media" && input.action === "status") {
        return Promise.resolve(status);
      }
      return Promise.resolve({});
    });
    const user = userEvent.setup();
    render(<GoogleCloudSettingsPage />);

    await user.selectOptions(
      await screen.findByLabelText("Billing Overview account type"),
      "not_verified",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(mockCallResource).toHaveBeenCalledWith("config", {
        action: "patch",
        path: "mediaKnowledge",
        updates: expect.objectContaining({
          promoGuard: expect.objectContaining({
            verifiedBillingAccountType: "not_verified",
            creditVerifiedBillingAccountType: "not_verified",
          }),
        }),
      });
    });
  });
});
