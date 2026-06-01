import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  BYOKCredential as ProviderCredential,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { ManageModelsDialog } from "./ManageModelsDialog.js";

describe("ManageModelsDialog", () => {
  const catalog: ProviderRegistryEntry[] = [
    {
      providerId: "google",
      displayName: "Google AI (Gemini)",
      authModes: ["api_key"],
      adapterFamily: "google-native",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: false,
        structuredOutputs: true,
      },
      modelSource: "remote",
    },
  ];

  const providerModels = {
    google: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google" },
    ],
  };

  const credentials: ProviderCredential[] = [
    {
      credentialId: "550e8400-e29b-41d4-a716-446655440000",
      userId: "user-1",
      workspaceId: "ws-1",
      providerId: "google",
      label: "Gemini",
      keyFingerprint: "abc123",
      encryptedSecretJson: "{}",
      keyVersion: "1",
      status: "connected",
      lastValidatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    },
  ];

  it("hides all models when turning a visible provider off", () => {
    const onToggleModelVisibility = vi.fn();
    const onSetProviderVisibleModels = vi.fn();

    render(
      <ManageModelsDialog
        isOpen={true}
        onClose={vi.fn()}
        catalog={catalog}
        credentials={credentials}
        providerModels={providerModels}
        visibleModelIds={{ google: new Set(["gemini-2.5-pro"]) }}
        loadingProviderModelIds={{}}
        onToggleModelVisibility={onToggleModelVisibility}
        onSetProviderVisibleModels={onSetProviderVisibleModels}
      />,
    );

    const providerToggle = screen.getByRole("switch", {
      name: /google ai \(gemini\) provider visibility/i,
    });

    fireEvent.click(providerToggle);
    expect(onSetProviderVisibleModels).toHaveBeenCalledWith("google", []);
  });

  it("restores all provider models when re-enabling a hidden provider", () => {
    const onSetProviderVisibleModels = vi.fn();

    render(
      <ManageModelsDialog
        isOpen={true}
        onClose={vi.fn()}
        catalog={catalog}
        credentials={credentials}
        providerModels={providerModels}
        visibleModelIds={{ google: new Set() }}
        loadingProviderModelIds={{}}
        onToggleModelVisibility={vi.fn()}
        onSetProviderVisibleModels={onSetProviderVisibleModels}
      />,
    );

    fireEvent.click(
      screen.getByRole("switch", {
        name: /google ai \(gemini\) provider visibility/i,
      }),
    );

    expect(onSetProviderVisibleModels).toHaveBeenCalledWith("google", [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ]);
  });

  it("keeps connected provider rows visible while models are still loading", () => {
    render(
      <ManageModelsDialog
        isOpen={true}
        onClose={vi.fn()}
        catalog={catalog}
        credentials={credentials}
        providerModels={{}}
        visibleModelIds={{}}
        loadingProviderModelIds={{ google: true }}
        onToggleModelVisibility={vi.fn()}
        onSetProviderVisibleModels={vi.fn()}
      />,
    );

    expect(screen.getByText("Google AI (Gemini)")).toBeInTheDocument();
    expect(screen.getByText(/models loading/i)).toBeInTheDocument();
  });

  it("sorts openrouter models by company and then model name", () => {
    const openRouterCatalog: ProviderRegistryEntry[] = [
      {
        providerId: "openrouter",
        displayName: "OpenRouter",
        authModes: ["api_key"],
        adapterFamily: "openai-compatible",
        capabilities: {
          streaming: true,
          tools: true,
          jsonMode: true,
          structuredOutputs: true,
        },
        modelSource: "remote",
      },
    ];

    const openRouterCredentials: ProviderCredential[] = [
      {
        credentialId: "550e8400-e29b-41d4-a716-446655440001",
        userId: "user-1",
        workspaceId: "ws-1",
        providerId: "openrouter",
        label: "OpenRouter",
        keyFingerprint: "def456",
        encryptedSecretJson: "{}",
        keyVersion: "1",
        status: "connected",
        lastValidatedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
    ];

    const openRouterModels = {
      openrouter: [
        { id: "z-ai/glm-4.5-air", name: "GLM 4.5 Air", provider: "openrouter" },
        {
          id: "anthropic/claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          provider: "openrouter",
        },
        {
          id: "anthropic/claude-opus-4.6",
          name: "Claude Opus 4.6",
          provider: "openrouter",
        },
      ],
    };

    render(
      <ManageModelsDialog
        isOpen={true}
        onClose={vi.fn()}
        catalog={openRouterCatalog}
        credentials={openRouterCredentials}
        providerModels={openRouterModels}
        visibleModelIds={{ openrouter: new Set() }}
        loadingProviderModelIds={{}}
        onToggleModelVisibility={vi.fn()}
        onSetProviderVisibleModels={vi.fn()}
      />,
    );

    const labels = screen
      .getAllByRole("switch")
      .map((node) => node.getAttribute("aria-label"));
    expect(labels).toContain("Claude Opus 4.6 visibility");
    expect(labels).toContain("Claude Sonnet 4.5 visibility");
    expect(labels).toContain("GLM 4.5 Air visibility");
    expect(labels.indexOf("Claude Opus 4.6 visibility")).toBeLessThan(
      labels.indexOf("Claude Sonnet 4.5 visibility"),
    );
    expect(labels.indexOf("Claude Sonnet 4.5 visibility")).toBeLessThan(
      labels.indexOf("GLM 4.5 Air visibility"),
    );
  });

  it("shows unavailable model reasons and disables their visibility toggles", () => {
    render(
      <ManageModelsDialog
        isOpen={true}
        onClose={vi.fn()}
        catalog={catalog}
        credentials={credentials}
        providerModels={{
          google: [
            {
              id: "unsupported-model",
              name: "Unsupported Model",
              provider: "google",
              availability: "unsupported_transport",
              unavailableReason: "Transport is not wired yet.",
            },
          ],
        }}
        visibleModelIds={{ google: new Set(["unsupported-model"]) }}
        loadingProviderModelIds={{}}
        onToggleModelVisibility={vi.fn()}
        onSetProviderVisibleModels={vi.fn()}
      />,
    );

    expect(screen.getByText("Transport is not wired yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", {
        name: /unsupported model visibility/i,
      }),
    ).toBeDisabled();
  });
});
