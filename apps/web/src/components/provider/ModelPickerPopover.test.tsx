/**
 * ModelPickerPopover Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ModelPickerPopover } from "./ModelPickerPopover";
import {
  BYOKCredential as ProviderCredential,
  type ProviderRegistryEntry,
} from "@repo/shared-types";
import { type ProviderModelOption } from "../../services/api/providerClient";

describe("ModelPickerPopover", () => {
  const mockCatalog: ProviderRegistryEntry[] = [
    {
      providerId: "axis",
      displayName: "Axis",
      authModes: ["platform_managed"],
      adapterFamily: "openai-compatible",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "static",
      defaultModelId: "z-ai/glm-4.5-air:free",
    },
    {
      providerId: "openai",
      displayName: "OpenAI",
      authModes: ["api_key"],
      adapterFamily: "openai-compatible",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "static",
      defaultModelId: "gpt-4",
    },
    {
      providerId: "anthropic",
      displayName: "Anthropic",
      authModes: ["api_key"],
      adapterFamily: "anthropic-native",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: false,
        structuredOutputs: false,
      },
      modelSource: "static",
      defaultModelId: "claude-3-opus",
    },
  ];

  const mockModels: Record<string, ProviderModelOption[]> = {
    axis: [
      {
        id: "z-ai/glm-4.5-air:free",
        name: "z-ai/glm-4.5-air:free",
      },
      {
        id: "nvidia/nemotron-3-nano-30b-a3b:free",
        name: "nvidia/nemotron-3-nano-30b-a3b:free",
      },
      {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        name: "nvidia/nemotron-3-super-120b-a12b:free",
      },
      {
        id: "qwen/qwen3.6-plus:free",
        name: "qwen/qwen3.6-plus:free",
      },
    ],
    openai: [
      { id: "gpt-4", name: "GPT-4" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
      {
        id: "gpt-unsupported",
        name: "GPT Unsupported",
        availability: "unsupported_transport",
      },
    ],
    anthropic: [
      { id: "claude-3-opus", name: "Claude 3 Opus" },
      { id: "claude-3-sonnet", name: "Claude 3 Sonnet" },
    ],
  };

  const mockHandlers = {
    onSelectModel: vi.fn(async () => {}),
    onSelectModelView: vi.fn(async () => {}),
    onLoadMoreSelectedProviderModels: vi.fn(async () => []),
    onRefreshSelectedProviderModels: vi.fn(async () => {}),
    onConnectProvider: vi.fn(),
    onManageModels: vi.fn(),
  };

  const mockVisibleModelIds: Record<string, Set<string>> = {
    // axis not included = show all (default behavior)
    openai: new Set(["gpt-4", "gpt-4-turbo"]),
    anthropic: new Set(["claude-3-opus", "claude-3-sonnet"]),
  };

  const mockCredentials: ProviderCredential[] = [
    {
      credentialId: "550e8400-e29b-41d4-a716-446655440000",
      userId: "user-1",
      workspaceId: "ws-1",
      providerId: "openai",
      label: "OpenAI",
      keyFingerprint: "abc123",
      encryptedSecretJson: "{}",
      keyVersion: "1",
      status: "connected",
      lastValidatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    },
    {
      credentialId: "550e8400-e29b-41d4-a716-446655440001",
      userId: "user-1",
      workspaceId: "ws-1",
      providerId: "anthropic",
      label: "Anthropic",
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

  const defaultProps = {
    catalog: mockCatalog,
    credentials: mockCredentials,
    providerModels: mockModels,
    visibleModelIds: mockVisibleModelIds,
    selectedProviderId: null as string | null,
    selectedModelId: null as string | null,
    selectedModelView: "popular" as const,
    ...mockHandlers,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Rendering", () => {
    it("renders trigger button with axis default label", () => {
      render(<ModelPickerPopover {...defaultProps} />);

      expect(
        screen.getByRole("button", { name: /open model picker/i }),
      ).toHaveTextContent("Axis (Free): z-ai/glm-4.5-air:free");
    });

    it("renders trigger button with selected model label", () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
        />,
      );

      expect(
        screen.getByRole("button", { name: /open model picker/i }),
      ).toHaveTextContent("OpenAI: GPT-4");
    });

    it("preserves the explicit selection label when the selected model is not in the current loaded slice", () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="removed-model"
        />,
      );

      expect(
        screen.getByRole("button", { name: /open model picker/i }),
      ).toHaveTextContent("OpenAI: removed-model");
    });

    it("preserves explicit selected model label while provider models are hydrating", () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          providerModels={{ axis: mockModels.axis ?? [] }}
          selectedProviderId="openai"
          selectedModelId="gpt-4-turbo"
        />,
      );

      expect(
        screen.getByRole("button", { name: /open model picker/i }),
      ).toHaveTextContent("OpenAI: gpt-4-turbo");
    });

    it("uses the hydration-specific loading label during full loading", () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          providerModels={{ axis: mockModels.axis ?? [] }}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
          isHydratingVisibleModels
          isLoading
        />,
      );

      expect(
        screen.getByRole("button", { name: /open model picker/i }),
      ).toHaveTextContent("Loading selected models...");

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      expect(screen.getByTestId("model-picker-popover")).toHaveTextContent(
        "Loading selected models...",
      );
    });

    it("opens popover on button click", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText(/search models/i),
        ).toBeInTheDocument();
      });
    });

    it("opens upward when there is not enough space below trigger", async () => {
      const originalInnerHeight = window.innerHeight;
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 640,
      });

      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      vi.spyOn(triggerButton, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 560,
        width: 200,
        height: 36,
        top: 560,
        right: 200,
        bottom: 596,
        left: 0,
        toJSON: () => ({}),
      });

      fireEvent.click(triggerButton);

      await waitFor(() => {
        const popover = screen.getByTestId("model-picker-popover");
        expect(popover.className).toContain("bottom-full");
      });

      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalInnerHeight,
      });
    });

    it("uses right alignment when viewport is narrow on the right", async () => {
      const originalInnerWidth = window.innerWidth;
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 700,
      });

      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      vi.spyOn(triggerButton, "getBoundingClientRect").mockReturnValue({
        x: 560,
        y: 200,
        width: 120,
        height: 36,
        top: 200,
        right: 680,
        bottom: 236,
        left: 560,
        toJSON: () => ({}),
      });

      fireEvent.click(triggerButton);

      await waitFor(() => {
        const popover = screen.getByTestId("model-picker-popover");
        expect(popover.className).toContain("right-0");
      });

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
    });
  });

  describe("Model Display", () => {
    it("shows included default axis models in a dedicated section", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      await waitFor(() => {
        expect(screen.getByText("LegionCode Axis")).toBeInTheDocument();
        expect(screen.getByText("z-ai/glm-4.5-air:free")).toBeInTheDocument();
      });
    });

    it("displays all providers and models when popover is open", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      await waitFor(() => {
        expect(screen.getByText("LegionCode Axis")).toBeInTheDocument();
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
        expect(screen.getByText("Anthropic")).toBeInTheDocument();
        expect(screen.getByText("GPT-4")).toBeInTheDocument();
        expect(screen.getByText("Claude 3 Opus")).toBeInTheDocument();
      });
    });

    it("shows checkmark for selected model", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      await waitFor(() => {
        const gpt4Button = screen.getByText("GPT-4").closest("button");
        expect(gpt4Button).toHaveClass("bg-neutral-800");
        expect(gpt4Button?.textContent).toContain("✓");
      });
    });

    it("shows connected provider sections even when models are still loading", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          providerModels={{ axis: mockModels.axis ?? [] }}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      await waitFor(() => {
        expect(screen.getByText("OpenAI")).toBeInTheDocument();
        expect(screen.getByText("Anthropic")).toBeInTheDocument();
        expect(screen.getAllByText(/models loading/i).length).toBeGreaterThan(
          0,
        );
      });
    });

    it("shows selected model id while provider models are hydrating", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          providerModels={{ axis: mockModels.axis ?? [] }}
          selectedProviderId="openai"
          selectedModelId="gpt-4-turbo"
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      await waitFor(() => {
        expect(screen.getByText("gpt-4-turbo")).toBeInTheDocument();
        expect(screen.queryByText("Pending")).not.toBeInTheDocument();
        expect(screen.queryByText("Stale")).not.toBeInTheDocument();
      });
    });

    it("keeps explicit selected model visible when provider models are partially loaded", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          providerModels={{
            axis: mockModels.axis ?? [],
            openai: [{ id: "gpt-4", name: "GPT-4" }],
          }}
          selectedProviderId="openai"
          selectedModelId="gpt-4-turbo"
        />,
      );

      expect(
        screen.getByRole("button", { name: /open model picker/i }),
      ).toHaveTextContent("OpenAI: gpt-4-turbo");

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      await waitFor(() => {
        expect(screen.getByText("gpt-4-turbo")).toBeInTheDocument();
        expect(screen.queryByText("Pending")).not.toBeInTheDocument();
      });
    });

    it("does not show pending selection when the selected model is hydrated but hidden", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          visibleModelIds={{
            ...mockVisibleModelIds,
            openai: new Set(["gpt-4"]),
          }}
          selectedProviderId="openai"
          selectedModelId="gpt-4-turbo"
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      await waitFor(() => {
        expect(screen.queryByText("Pending")).not.toBeInTheDocument();
        expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
      });
    });
  });

  describe("Search", () => {
    it("filters models by search query", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const searchInput = await screen.findByPlaceholderText(/search models/i);
      fireEvent.change(searchInput, { target: { value: "gpt" } });

      await waitFor(() => {
        expect(screen.getByText("GPT-4")).toBeInTheDocument();
        expect(screen.getByText("GPT-4 Turbo")).toBeInTheDocument();
        expect(screen.queryByText("Claude 3 Opus")).not.toBeInTheDocument();
      });
    });

    it("filters by provider name", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const searchInput = await screen.findByPlaceholderText(/search models/i);
      fireEvent.change(searchInput, { target: { value: "anthropic" } });

      await waitFor(() => {
        expect(screen.getByText("Claude 3 Opus")).toBeInTheDocument();
        expect(screen.queryByText("GPT-4")).not.toBeInTheDocument();
      });
    });

    it("shows empty message when no models match search", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const searchInput = await screen.findByPlaceholderText(/search models/i);
      fireEvent.change(searchInput, { target: { value: "nonexistent" } });

      await waitFor(() => {
        expect(
          screen.getByText(/no models match your search/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Selection", () => {
    it("calls onSelectModel when model is clicked", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const gpt4Button = await screen.findByText("GPT-4");
      const modelButton = gpt4Button.closest("button");

      fireEvent.click(modelButton!);

      await waitFor(() => {
        expect(mockHandlers.onSelectModel).toHaveBeenCalledWith(
          "openai",
          "gpt-4",
        );
      });
    });

    it("disables unavailable models and does not select them", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          visibleModelIds={{
            ...mockVisibleModelIds,
            openai: new Set(["gpt-4", "gpt-4-turbo", "gpt-unsupported"]),
          }}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      const unavailableButton = (
        await screen.findByText("GPT Unsupported")
      ).closest("button");

      expect(unavailableButton).toBeDisabled();
      expect(unavailableButton).toHaveTextContent("Unavailable");

      fireEvent.click(unavailableButton!);
      expect(mockHandlers.onSelectModel).not.toHaveBeenCalledWith(
        "openai",
        "gpt-unsupported",
      );
    });

    it("closes popover after model selection", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const gpt4Button = await screen.findByText("GPT-4");
      const modelButton = gpt4Button.closest("button");

      fireEvent.click(modelButton!);

      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText(/search models/i),
        ).not.toBeInTheDocument();
      });
    });

    it("closes popover immediately when selection persistence fails", async () => {
      const onSelectModel = vi.fn(async () => {
        throw new Error("Provider state unavailable");
      });
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      try {
        render(
          <ModelPickerPopover
            {...defaultProps}
            onSelectModel={onSelectModel}
            selectedProviderId={null}
            selectedModelId={null}
          />,
        );

        fireEvent.click(
          screen.getByRole("button", { name: /open model picker/i }),
        );

        const gpt4Button = await screen.findByText("GPT-4");
        const modelButton = gpt4Button.closest("button");

        fireEvent.click(modelButton!);

        await waitFor(() => {
          expect(
            screen.queryByTestId("model-picker-popover"),
          ).not.toBeInTheDocument();
        });
        await waitFor(() => {
          expect(onSelectModel).toHaveBeenCalledWith("openai", "gpt-4");
        });
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "[model-picker/select] Failed to persist model selection:",
          expect.any(Error),
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it("resets search query after selection", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const searchInput = (await screen.findByPlaceholderText(
        /search models/i,
      )) as HTMLInputElement;
      fireEvent.change(searchInput, { target: { value: "gpt" } });

      const gpt4Button = await screen.findByText("GPT-4");
      const modelButton = gpt4Button.closest("button");

      fireEvent.click(modelButton!);

      // Wait for async selection flow to close popover first
      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText(/search models/i),
        ).not.toBeInTheDocument();
      });

      // Reopen and verify search is reset
      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );
      const newSearchInput = (await screen.findByPlaceholderText(
        /search models/i,
      )) as HTMLInputElement;
      expect(newSearchInput.value).toBe("");
    });
  });

  describe("Actions", () => {
    it("calls onConnectProvider when Connect button is clicked", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const connectButton = await screen.findByRole("button", {
        name: /connect provider/i,
      });
      fireEvent.click(connectButton);

      expect(mockHandlers.onConnectProvider).toHaveBeenCalled();
    });

    it("closes popover when Connect button is clicked", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId={null}
          selectedModelId={null}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const connectButton = await screen.findByRole("button", {
        name: /connect provider/i,
      });
      fireEvent.click(connectButton);

      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText(/search models/i),
        ).not.toBeInTheDocument();
      });
    });

    it("enables manage button and calls onManageModels", async () => {
      const handleManageModels = vi.fn();
      render(
        <ModelPickerPopover
          {...defaultProps}
          onManageModels={handleManageModels}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      const manageButton = await screen.findByRole("button", {
        name: /manage model visibility/i,
      });
      expect(manageButton).not.toBeDisabled();

      fireEvent.click(manageButton);
      expect(handleManageModels).toHaveBeenCalled();
    });

    it("switches model view to all and calls callback", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );
      const allButton = await screen.findByRole("button", { name: "All" });
      fireEvent.click(allButton);

      await waitFor(() => {
        expect(mockHandlers.onSelectModelView).toHaveBeenCalledWith("all");
      });
    });

    it("labels the popular tab as recommended for openrouter", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          catalog={[
            ...mockCatalog,
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
              defaultModelId: "openrouter/auto",
            },
          ]}
          providerModels={{
            ...mockModels,
            openrouter: [{ id: "openrouter/auto", name: "Auto (Best Model)" }],
          }}
          visibleModelIds={{
            ...mockVisibleModelIds,
            openrouter: new Set(["openrouter/auto"]),
          }}
          selectedProviderId="openrouter"
          selectedModelId="openrouter/auto"
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      expect(
        await screen.findByRole("button", { name: "Recommended" }),
      ).toBeInTheDocument();
    });

    it("refreshes selected provider models when metadata is stale", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
          selectedProviderMetadata={{
            fetchedAt: new Date().toISOString(),
            stale: true,
            source: "cache",
            staleReason: "provider_api_unavailable",
          }}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );
      await screen.findByRole("button", { name: /refresh/i });
      expect(screen.queryByText("Stale")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
      await waitFor(() => {
        expect(
          mockHandlers.onRefreshSelectedProviderModels,
        ).toHaveBeenCalledWith("openai");
      });
    });

    it("loads more models when pagination is available", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
          hasMoreSelectedProviderModels={true}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );
      const loadMoreButton = await screen.findByRole("button", {
        name: /load more/i,
      });
      fireEvent.click(loadMoreButton);

      await waitFor(() => {
        expect(
          mockHandlers.onLoadMoreSelectedProviderModels,
        ).toHaveBeenCalledWith("openai");
      });
    });

    it("disables or hides discovery controls when callbacks are not provided", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
          hasMoreSelectedProviderModels={true}
          onSelectModelView={undefined}
          onRefreshSelectedProviderModels={undefined}
          onLoadMoreSelectedProviderModels={undefined}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );
      expect(await screen.findByRole("button", { name: "All" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Popular" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: /load more/i }),
      ).not.toBeInTheDocument();
    });

    it("logs async handler errors instead of leaking unhandled rejections", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const onRefreshSelectedProviderModels = vi.fn(async () => {
        throw new Error("refresh failed");
      });

      try {
        render(
          <ModelPickerPopover
            {...defaultProps}
            selectedProviderId="openai"
            selectedModelId="gpt-4"
            onRefreshSelectedProviderModels={onRefreshSelectedProviderModels}
          />,
        );

        fireEvent.click(
          screen.getByRole("button", { name: /open model picker/i }),
        );
        fireEvent.click(
          await screen.findByRole("button", { name: /refresh/i }),
        );

        await waitFor(() => {
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            "[model-picker/refresh] Failed to refresh models:",
            expect.any(Error),
          );
        });
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });
  });

  describe("Outside Click", () => {
    it("closes popover when clicking outside", async () => {
      render(
        <div>
          <ModelPickerPopover
            {...defaultProps}
            selectedProviderId={null}
            selectedModelId={null}
          />
          <div data-testid="outside">Outside element</div>
        </div>,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText(/search models/i),
        ).toBeInTheDocument();
      });

      const outside = screen.getByTestId("outside");
      fireEvent.mouseDown(outside);

      await waitFor(() => {
        expect(
          screen.queryByPlaceholderText(/search models/i),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("Loading State", () => {
    it("shows a loading view when isLoading is true", async () => {
      render(<ModelPickerPopover {...defaultProps} isLoading={true} />);

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      expect(triggerButton).toHaveTextContent(/loading models/i);

      fireEvent.click(triggerButton);

      expect(
        await screen.findByText(
          /fetching available models from your providers/i,
        ),
      ).toBeInTheDocument();
    });

    it("shows inline loading text while selected provider models are still loading", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
          isLoading={false}
          isLoadingMoreSelectedProviderModels={true}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      expect(await screen.findByText("Loading models...")).toBeInTheDocument();
    });

    it("shows inline selected-model hydration loading text", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          selectedProviderId="openai"
          selectedModelId="gpt-4"
          isHydratingVisibleModels={true}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", { name: /open model picker/i }),
      );

      expect(
        await screen.findByText("Loading selected models..."),
      ).toBeInTheDocument();
    });
  });

  describe("Empty State", () => {
    it("shows empty message when no providers are connected", async () => {
      render(
        <ModelPickerPopover
          {...defaultProps}
          catalog={[]}
          credentials={[]}
          providerModels={{}}
        />,
      );

      const triggerButton = screen.getByRole("button", {
        name: /open model picker/i,
      });
      fireEvent.click(triggerButton);

      await waitFor(() => {
        expect(
          screen.getByText(/no models available yet/i),
        ).toBeInTheDocument();
      });
    });
  });
});
