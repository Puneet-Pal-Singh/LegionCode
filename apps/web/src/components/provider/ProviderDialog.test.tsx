/**
 * ProviderDialog Component Tests
 *
 * Tests for tabs, credential management, and preferences.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProviderDialog } from "./ProviderDialog.js";
import * as useProviderStoreModule from "../../hooks/useProviderStore.js";

describe("ProviderDialog", () => {
  type UseProviderStoreResult = ReturnType<
    typeof useProviderStoreModule.useProviderStore
  >;
  let mockStore: UseProviderStoreResult;
  const credentialId = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    mockStore = {
      catalog: [
        {
          providerId: "openai",
          displayName: "OpenAI",
          authModes: ["api_key"],
          launchStage: "supported",
          adapterFamily: "openai-compatible",
          capabilities: {
            streaming: true,
            tools: true,
            jsonMode: true,
            structuredOutputs: true,
          },
          modelSource: "static",
          keyFormat: {
            prefix: "sk-",
            description: "OpenAI API key (starts with sk-)",
          },
        },
      ],
      credentials: [
        {
          credentialId,
          userId: "user-1",
          workspaceId: "ws-1",
          providerId: "openai",
          label: "Default key",
          keyFingerprint: "abc123xyz",
          encryptedSecretJson: "{}",
          keyVersion: "1",
          status: "connected",
          lastValidatedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        },
      ],
      providerModels: {
        openai: [
          {
            id: "gpt-4",
            name: "GPT-4",
            provider: "openai",
          },
        ],
      },
      manageProviderModels: {},
      providerModelsMetadata: {
        openai: {
          fetchedAt: new Date().toISOString(),
          stale: false,
          source: "provider_api",
        },
      },
      providerModelsPage: {
        openai: {
          view: "popular",
          nextCursor: null,
          hasMore: false,
        },
      },
      visibleModelIds: {},
      preferences: {
        userId: "user-1",
        workspaceId: "ws-1",
        defaultProviderId: "openai",
        defaultModelId: "gpt-4",
        visibleModelIds: {},
        updatedAt: new Date().toISOString(),
      },
      selectedProviderId: "openai",
      selectedCredentialId: credentialId,
      selectedModelId: "gpt-4",
      selectedModelView: "popular",
      status: "ready",
      error: null,
      isValidating: false,
      loadingModelsForProviderId: null,
      loadingManageModelsForProviderIds: {},
      refreshingModelsForProviderId: null,
      lastResolvedConfig: {
        providerId: "openai",
        credentialId,
        modelId: "gpt-4",
        resolvedAt: "workspace_preference",
        resolvedAtTime: new Date().toISOString(),
      },
      bootstrap: vi.fn(async () => undefined),
      connectCredential: vi.fn(async () => undefined),
      disconnectCredential: vi.fn(async () => undefined),
      validateCredential: vi.fn(async () => undefined),
      loadProviderModels: vi.fn(async () => [
        {
          id: "gpt-4",
          name: "GPT-4",
          provider: "openai",
        },
      ]),
      loadManageProviderModels: vi.fn(async () => []),
      loadMoreProviderModels: vi.fn(async () => []),
      refreshProviderModels: vi.fn(async () => undefined),
      setModelView: vi.fn(async () => undefined),
      updatePreferences: vi.fn(async () => undefined),
      setSelection: vi.fn(),
      applySessionSelection: vi.fn(async () => ({
        providerId: "openai",
        credentialId,
        modelId: "gpt-4",
        resolvedAt: "workspace_preference" as const,
        resolvedAtTime: new Date().toISOString(),
      })),
      resolveForChat: vi.fn(async () => ({
        providerId: "openai",
        credentialId,
        modelId: "gpt-4",
        resolvedAt: "workspace_preference" as const,
        resolvedAtTime: new Date().toISOString(),
      })),
      toggleModelVisibility: vi.fn(),
      setProviderVisibleModels: vi.fn(),
      clearError: vi.fn(),
      reset: vi.fn(),
    };

    vi.spyOn(useProviderStoreModule, "useProviderStore").mockReturnValue(
      mockStore,
    );
  });

  describe("rendering", () => {
    it("renders dialog when isOpen is true", () => {
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText("Provider & Model Settings")).toBeInTheDocument();
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("does not render dialog when isOpen is false", () => {
      const { container } = render(
        <ProviderDialog isOpen={false} onClose={vi.fn()} />,
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe("Connected tab", () => {
    it("displays connected credentials", () => {
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText("Default key")).toBeInTheDocument();
      expect(screen.getByText("Provider: openai")).toBeInTheDocument();
    });

    it("shows empty state when no credentials", () => {
      mockStore.credentials = [];
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      expect(
        screen.getByText(/No provider keys connected yet/),
      ).toBeInTheDocument();
      expect(screen.getByText("Add Provider Key")).toBeInTheDocument();
    });

    it("calls disconnectCredential when remove clicked", async () => {
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      const removeButton = screen.getByText("Remove");
      fireEvent.click(removeButton);

      await waitFor(() => {
        expect(mockStore.disconnectCredential).toHaveBeenCalledWith(
          credentialId,
        );
      });
    });

    it("calls validateCredential when test clicked", async () => {
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      const testButton = screen.getByText("Test");
      fireEvent.click(testButton);

      await waitFor(() => {
        expect(mockStore.validateCredential).toHaveBeenCalledWith(
          credentialId,
          "format",
        );
      });
    });
  });

  describe("Available tab", () => {
    it("shows form to add new credential", () => {
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      const availableTab = screen.getByText("Available");
      fireEvent.click(availableTab);

      // ConnectProviderChooser shows "Find Provider" label
      expect(screen.getByText("Find Provider")).toBeInTheDocument();
      // And the search input
      expect(
        screen.getByPlaceholderText(/search providers/i),
      ).toBeInTheDocument();
    });

    it("calls connectCredential with form data", async () => {
      const onClose = vi.fn();
      render(<ProviderDialog isOpen={true} onClose={onClose} />);

      const availableTab = screen.getByText("Available");
      fireEvent.click(availableTab);

      // Click provider in the list
      const openaiButton = screen.getByText("OpenAI").closest("button");
      fireEvent.click(openaiButton!);

      // Fill in API key
      const secretInput = await screen.findByPlaceholderText(/api key/i);
      fireEvent.change(secretInput, { target: { value: "sk-test123" } });

      const connectButton = screen.getByRole("button", {
        name: /submit/i,
      });
      fireEvent.click(connectButton);

      await waitFor(() => {
        expect(mockStore.connectCredential).toHaveBeenCalledWith({
          providerId: "openai",
          secret: "sk-test123",
          label: undefined,
        });
        // In full mode, stays open and navigates to manage models instead of closing
        expect(onClose).not.toHaveBeenCalled();
        // Verify manage models view is shown
        expect(
          screen.getByRole("heading", { name: /manage models/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByText("OpenAI connected. Choose your models next."),
        ).toBeInTheDocument();
        expect(
          screen.getByText(/Choose the models you want to show in the model selector next/i),
        ).toBeInTheDocument();
        expect(
          screen.getByText(/Select which models from this provider should appear in the model picker before you continue/i),
        ).toBeInTheDocument();
      });
    });

    it("opens Available tab when initialTab is provided", () => {
      render(
        <ProviderDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="available"
        />,
      );

      expect(screen.getByText("Find Provider")).toBeInTheDocument();
    });
  });

  describe("Preferences tab", () => {
    it("shows explicit selection policy copy", () => {
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      const prefTab = screen.getByText("Preferences");
      fireEvent.click(prefTab);

      expect(screen.getByText(/Explicit Selection Policy/)).toBeInTheDocument();
      expect(
        screen.getByText(/No hidden provider fallback is applied/),
      ).toBeInTheDocument();
    });

    it("does not render legacy fallback controls", async () => {
      render(<ProviderDialog isOpen={true} onClose={vi.fn()} />);

      const prefTab = screen.getByText("Preferences");
      fireEvent.click(prefTab);

      expect(screen.queryByLabelText(/Allow Fallback/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Strict/)).not.toBeInTheDocument();
      expect(mockStore.updatePreferences).not.toHaveBeenCalled();
    });
  });

  describe("Session tab", () => {
    it("shows provider/credential/model selector", () => {
      render(
        <ProviderDialog isOpen={true} onClose={vi.fn()} mode="composer" />,
      );

      // Session tab should be active in composer mode
      expect(screen.getByText("Active Session")).toBeInTheDocument();
    });

    it("opens manage models dialog when initialView is manage-models", () => {
      render(
        <ProviderDialog
          isOpen={true}
          onClose={vi.fn()}
          initialView="manage-models"
        />,
      );

      expect(
        screen.getByRole("heading", { name: /manage models/i }),
      ).toBeInTheDocument();
    });
  });

  describe("close button", () => {
    it("calls onClose when close button clicked", () => {
      const onClose = vi.fn();
      render(<ProviderDialog isOpen={true} onClose={onClose} />);

      const closeButton = screen.getByLabelText("Close");
      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalled();
    });

    it("calls onClose when footer close button clicked", () => {
      const onClose = vi.fn();
      render(<ProviderDialog isOpen={true} onClose={onClose} />);

      const footerCloseButtons = screen.getAllByRole("button", {
        name: /Close/i,
      });
      const footerCloseButton = footerCloseButtons[1];
      expect(footerCloseButton).toBeDefined();
      if (footerCloseButton) {
        fireEvent.click(footerCloseButton);
      }

      expect(onClose).toHaveBeenCalled();
    });

    it("calls onClose when backdrop is clicked", () => {
      const onClose = vi.fn();
      render(<ProviderDialog isOpen={true} onClose={onClose} />);

      fireEvent.click(screen.getByTestId("provider-dialog-overlay"));

      expect(onClose).toHaveBeenCalled();
    });

    it("calls onClose when escape is pressed", () => {
      const onClose = vi.fn();
      render(<ProviderDialog isOpen={true} onClose={onClose} />);

      fireEvent.keyDown(window, { key: "Escape" });

      expect(onClose).toHaveBeenCalled();
    });

    it("closes manage models overlay first on escape in full dialog", async () => {
      const onClose = vi.fn();
      render(
        <ProviderDialog
          isOpen={true}
          onClose={onClose}
          initialView="manage-models"
        />,
      );

      expect(
        screen.getByRole("heading", { name: /manage models/i }),
      ).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Escape" });

      await waitFor(() => {
        expect(
          screen.queryByRole("heading", { name: /manage models/i }),
        ).not.toBeInTheDocument();
      });
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe("connect-only variant", () => {
    it("shows connect provider modal without tab strip", () => {
      render(
        <ProviderDialog
          isOpen={true}
          onClose={vi.fn()}
          variant="connect-only"
        />,
      );

      expect(
        screen.getByRole("heading", { level: 2, name: "Connect provider" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Connected")).not.toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/search providers/i),
      ).toBeInTheDocument();
    });

    it("closes on escape", () => {
      const onClose = vi.fn();
      render(
        <ProviderDialog
          isOpen={true}
          onClose={onClose}
          variant="connect-only"
        />,
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });

    it("redirects to manage models with guidance after a successful connect", async () => {
      render(
        <ProviderDialog
          isOpen={true}
          onClose={vi.fn()}
          variant="connect-only"
        />,
      );

      const openaiButton = screen.getByText("OpenAI").closest("button");
      fireEvent.click(openaiButton!);

      const secretInput = await screen.findByPlaceholderText(/api key/i);
      fireEvent.change(secretInput, { target: { value: "sk-test123" } });

      fireEvent.click(
        screen.getByRole("button", {
          name: /submit/i,
        }),
      );

      await waitFor(() => {
        expect(
          screen.getByRole("heading", { name: /manage models/i }),
        ).toBeInTheDocument();
        expect(
          screen.getByText("OpenAI connected. Choose your models next."),
        ).toBeInTheDocument();
        expect(
          screen.getByText(/Choose the models you want to show in the model selector next/i),
        ).toBeInTheDocument();
        expect(
          screen.getByText(/Select which models from this provider should appear in the model picker before you continue/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("manage-models-only variant", () => {
    it("shows manage models modal without provider settings shell", () => {
      render(
        <ProviderDialog
          isOpen={true}
          onClose={vi.fn()}
          variant="manage-models-only"
        />,
      );

      expect(
        screen.getByRole("heading", { name: /manage models/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Provider & Model Settings"),
      ).not.toBeInTheDocument();
      expect(
        screen.getAllByRole("button", { name: /connect provider/i }).length,
      ).toBeGreaterThan(0);
    });

    it("opens connect provider helper flow from manage models only modal", () => {
      render(
        <ProviderDialog
          isOpen={true}
          onClose={vi.fn()}
          variant="manage-models-only"
        />,
      );

      const connectButtons = screen.getAllByRole("button", {
        name: /connect provider/i,
      });
      const firstConnectButton = connectButtons[0];
      expect(firstConnectButton).toBeDefined();
      if (firstConnectButton) {
        fireEvent.click(firstConnectButton);
      }

      expect(
        screen.getByRole("heading", { level: 2, name: /connect provider/i }),
      ).toBeInTheDocument();
    });

    it("closes when manage models backdrop is clicked", () => {
      const onClose = vi.fn();
      render(
        <ProviderDialog
          isOpen={true}
          onClose={onClose}
          variant="manage-models-only"
        />,
      );

      fireEvent.click(screen.getByTestId("manage-models-overlay"));
      expect(onClose).toHaveBeenCalled();
    });

    it("closes on escape", () => {
      const onClose = vi.fn();
      render(
        <ProviderDialog
          isOpen={true}
          onClose={onClose}
          variant="manage-models-only"
        />,
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });
  });
});
