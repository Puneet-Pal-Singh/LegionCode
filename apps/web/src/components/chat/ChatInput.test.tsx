/**
 * ChatInput Component Tests
 *
 * Tests for send gating and provider resolution integration.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChatInput } from "./ChatInput.js";
import * as useProviderStoreModule from "../../hooks/useProviderStore.js";

describe("ChatInput", () => {
  type UseProviderStoreResult = ReturnType<typeof useProviderStoreModule.useProviderStore>;
  let mockStore: UseProviderStoreResult;
  let onSendMessage: (message: string) => Promise<void>;
  const credentialId = "550e8400-e29b-41d4-a716-446655440000";

  beforeEach(() => {
    onSendMessage = vi.fn(async (message: string) => {
      void message;
      return undefined;
    });

    mockStore = {
      catalog: [],
      credentials: [],
      preferences: null,
      providerModels: {},
      manageProviderModels: {},
      providerModelsMetadata: {},
      providerModelsPage: {},
      visibleModelIds: {},
      selectedProviderId: "openai",
      selectedCredentialId: credentialId,
      selectedModelId: "gpt-4",
      selectedModelView: "popular",
      lastResolvedConfig: {
        providerId: "openai",
        credentialId,
        modelId: "gpt-4",
        resolvedAt: "workspace_preference",
        resolvedAtTime: new Date().toISOString(),
      },
      status: "ready",
      error: null,
      isValidating: false,
      loadingModelsForProviderId: null,
      loadingManageModelsForProviderIds: {},
      refreshingModelsForProviderId: null,
      bootstrap: vi.fn(async () => undefined),
      connectCredential: vi.fn(async () => undefined),
      disconnectCredential: vi.fn(async (credentialId: string) => {
        void credentialId;
        return undefined;
      }),
      validateCredential: vi.fn(
        async (credentialId: string, mode: "format" | "live") => {
          void credentialId;
          void mode;
          return undefined;
        }
      ),
      updatePreferences: vi.fn(async (partial: Record<string, unknown>) => {
        void partial;
        return undefined;
      }),
      loadProviderModels: vi.fn(async (providerId: string) => {
        void providerId;
        return [];
      }),
      ensureProviderModelsFresh: vi.fn(async () => []),
      loadManageProviderModels: vi.fn(async (providerId: string) => {
        void providerId;
        return [];
      }),
      loadMoreProviderModels: vi.fn(async (providerId: string) => {
        void providerId;
        return [];
      }),
      refreshProviderModels: vi.fn(async (providerId: string) => {
        void providerId;
      }),
      setModelView: vi.fn(async (view: "all" | "popular") => {
        void view;
      }),
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

    vi.spyOn(useProviderStoreModule, "useProviderStore").mockReturnValue(mockStore);
  });

  describe("send gating", () => {
    it("disables send button when status is loading", () => {
      mockStore.status = "loading";
      mockStore.lastResolvedConfig = null;

      render(<ChatInput onSendMessage={onSendMessage} />);

      const sendButton = screen.getByText("Send");
      expect(sendButton).toBeDisabled();
    });

    it("disables send button when status is error", () => {
      mockStore.status = "error";
      mockStore.error = "Failed to load credentials";
      mockStore.lastResolvedConfig = null;

      render(<ChatInput onSendMessage={onSendMessage} />);

      const sendButton = screen.getByText("Send");
      expect(sendButton).toBeDisabled();
    });

    it("allows send when ready and resolved", async () => {
      render(<ChatInput onSendMessage={onSendMessage} />);

      const textarea = screen.getByPlaceholderText(
        /Type your message/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello" } });

      const sendButton = screen.getByText("Send");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(onSendMessage).toHaveBeenCalledWith("Hello");
      });
    });

  });

  describe("message handling", () => {
    it("clears message after sending", async () => {
      render(<ChatInput onSendMessage={onSendMessage} />);

      const textarea = screen.getByPlaceholderText(
        /Type your message/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello" } });

      const sendButton = screen.getByText("Send");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(textarea.value).toBe("");
      });
    });

    it("trims whitespace before sending", async () => {
      render(<ChatInput onSendMessage={onSendMessage} />);

      const textarea = screen.getByPlaceholderText(
        /Type your message/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "  Hello  \n" } });

      const sendButton = screen.getByText("Send");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(onSendMessage).toHaveBeenCalledWith("Hello");
      });
    });

    it("restores message on send error", async () => {
      onSendMessage = vi.fn(
        async (message: string): Promise<void> => {
          void message;
          throw new Error("Send failed");
        }
      );

      render(<ChatInput onSendMessage={onSendMessage} />);

      const textarea = screen.getByPlaceholderText(
        /Type your message/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello" } });

      const sendButton = screen.getByText("Send");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(textarea.value).toBe("Hello");
      });
    });
  });

  describe("keyboard shortcuts", () => {
    it("sends message on Enter key", async () => {
      render(<ChatInput onSendMessage={onSendMessage} />);

      const textarea = screen.getByPlaceholderText(
        /Type your message/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello" } });

      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        expect(onSendMessage).toHaveBeenCalledWith("Hello");
      });
    });

    it("creates new line on Shift+Enter", () => {
      render(<ChatInput onSendMessage={onSendMessage} />);

      const textarea = screen.getByPlaceholderText(
        /Type your message/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello" } });

      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      // Should not send
      expect(onSendMessage).not.toHaveBeenCalled();
    });
  });

  describe("UI state", () => {
    it("shows loading state while sending", async () => {
      onSendMessage = vi.fn(async (message: string): Promise<void> => {
        void message;
        return await new Promise<void>(() => {});
      });

      render(<ChatInput onSendMessage={onSendMessage} />);

      const textarea = screen.getByPlaceholderText(
        /Type your message/
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "Hello" } });

      const sendButton = screen.getByText("Send");
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText(/Sending.../)).toBeInTheDocument();
      });
    });

    it("shows resolved config info", () => {
      render(<ChatInput onSendMessage={onSendMessage} />);

      expect(screen.getByText(/Using openai · gpt-4/)).toBeInTheDocument();
    });

    it("bootstraps store on mount", () => {
      mockStore.status = "idle";
      render(<ChatInput onSendMessage={onSendMessage} />);

      expect(mockStore.bootstrap).toHaveBeenCalled();
    });
  });
});
