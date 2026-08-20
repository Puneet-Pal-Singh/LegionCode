import { describe, expect, it } from "vitest";
import {
  isProviderModelBootstrapLoading,
  isProviderVisibleModelHydrationPending,
} from "./provider-model-bootstrap-loading";

describe("isProviderModelBootstrapLoading", () => {
  it("returns true while provider bootstrap status is loading", () => {
    expect(
      isProviderModelBootstrapLoading({
        status: "loading",
        providerModels: {},
      }),
    ).toBe(true);
  });

  it("returns true when the selected provider has not loaded models", () => {
    expect(
      isProviderModelBootstrapLoading({
        status: "ready",
        providerModels: {},
        selectedProviderId: "openrouter",
      }),
    ).toBe(true);
  });

  it("returns false when no provider is selected or the selected provider is hydrated", () => {
    expect(
      isProviderModelBootstrapLoading({
        status: "ready",
        providerModels: {
          openrouter: [
            {
              id: "openrouter/auto",
              name: "OpenRouter Auto",
              provider: "openrouter",
            },
          ],
        },
        selectedProviderId: "openrouter",
      }),
    ).toBe(false);
    expect(
      isProviderModelBootstrapLoading({
        status: "ready",
        providerModels: {},
      }),
    ).toBe(false);
  });
});

describe("isProviderVisibleModelHydrationPending", () => {
  it("returns false before selected provider picker models are loaded", () => {
    expect(
      isProviderVisibleModelHydrationPending({
        selectedProviderId: "openrouter",
        providerModels: {},
        visibleModelIds: {
          openrouter: new Set(["model-a"]),
        },
        manageProviderModels: {},
      }),
    ).toBe(false);
  });

  it("returns true when selected visible models are missing from picker models", () => {
    expect(
      isProviderVisibleModelHydrationPending({
        selectedProviderId: "openrouter",
        providerModels: {
          openrouter: [
            { id: "model-a", name: "Model A", provider: "openrouter" },
            { id: "model-b", name: "Model B", provider: "openrouter" },
          ],
        },
        visibleModelIds: {
          openrouter: new Set(["model-a", "model-b", "model-c"]),
        },
        manageProviderModels: {},
      }),
    ).toBe(true);
  });

  it("returns false once manage models have hydrated for the selected provider", () => {
    expect(
      isProviderVisibleModelHydrationPending({
        selectedProviderId: "openrouter",
        providerModels: {
          openrouter: [
            { id: "model-a", name: "Model A", provider: "openrouter" },
            { id: "model-b", name: "Model B", provider: "openrouter" },
          ],
        },
        visibleModelIds: {
          openrouter: new Set(["model-a", "model-b", "model-c"]),
        },
        manageProviderModels: {
          openrouter: [
            { id: "model-a", name: "Model A", provider: "openrouter" },
            { id: "model-b", name: "Model B", provider: "openrouter" },
            { id: "model-c", name: "Model C", provider: "openrouter" },
          ],
        },
      }),
    ).toBe(false);
  });

  it("returns false after manage-model hydration settles unavailable", () => {
    expect(
      isProviderVisibleModelHydrationPending({
        selectedProviderId: "openrouter",
        providerModels: {
          openrouter: [
            { id: "model-a", name: "Model A", provider: "openrouter" },
          ],
        },
        visibleModelIds: {
          openrouter: new Set(["model-a", "model-b"]),
        },
        manageProviderModels: {
          openrouter: [],
        },
      }),
    ).toBe(false);
  });
});
