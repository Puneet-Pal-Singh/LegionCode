import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { ChatInputBar } from "./ChatInputBar.js";
import * as useProviderStoreModule from "../../hooks/useProviderStore.js";
import * as providerHelpersModule from "../../lib/provider-helpers.js";

const IDLE_SWITCH_WARNING =
  "Changing models mid-conversation will degrade performance.";
const ACTIVE_RUN_SWITCH_WARNING =
  "Stop the current run before changing mode or model.";

describe("ChatInputBar", () => {
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
          adapterFamily: "openai-compatible",
          capabilities: {
            streaming: true,
            tools: true,
            jsonMode: true,
            structuredOutputs: true,
          },
          modelSource: "static",
        },
      ],
      credentials: [
        {
          credentialId,
          userId: "user-1",
          workspaceId: "workspace-1",
          providerId: "openai",
          label: "OpenAI Key",
          keyFingerprint: "openai-key-fingerprint",
          encryptedSecretJson: "{}",
          keyVersion: "1",
          status: "connected",
          lastValidatedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          deletedAt: null,
        },
      ],
      preferences: null,
      providerModels: {
        openai: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
      },
      manageProviderModels: {},
      providerModelsMetadata: {},
      providerModelsPage: {},
      visibleModelIds: { openai: new Set(["gpt-4o"]) },
      selectedProviderId: "openai",
      selectedCredentialId: credentialId,
      selectedModelId: "gpt-4o",
      selectedModelView: "popular",
      lastResolvedConfig: {
        providerId: "openai",
        credentialId,
        modelId: "gpt-4o",
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
      disconnectCredential: vi.fn(async () => undefined),
      validateCredential: vi.fn(async () => undefined),
      updatePreferences: vi.fn(async () => undefined),
      loadProviderModels: vi.fn(async () => []),
      loadManageProviderModels: vi.fn(async () => []),
      loadMoreProviderModels: vi.fn(async () => []),
      refreshProviderModels: vi.fn(async () => undefined),
      setModelView: vi.fn(async () => undefined),
      setSelection: vi.fn(),
      applySessionSelection: vi.fn(async () => ({
        providerId: "openai",
        credentialId,
        modelId: "gpt-4o",
        resolvedAt: "workspace_preference" as const,
        resolvedAtTime: new Date().toISOString(),
      })),
      resolveForChat: vi.fn(async () => ({
        providerId: "openai",
        credentialId,
        modelId: "gpt-4o",
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

    vi.spyOn(
      providerHelpersModule,
      "findCredentialByProviderId",
    ).mockReturnValue({
      credentialId,
      userId: "user-1",
      workspaceId: "workspace-1",
      providerId: "openai",
      label: "OpenAI Key",
      keyFingerprint: "openai-key-fingerprint",
      encryptedSecretJson: "{}",
      keyVersion: "1",
      status: "connected",
      lastValidatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });

  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a stop action when a selected run can still be cancelled", () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();

    render(
      <ChatInputBar
        input=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        onStop={onStop}
        canStop
        isLoading={false}
        sessionId="session-1"
      />,
    );

    fireEvent.click(screen.getByLabelText("Stop generation"));

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("scopes provider selection to the active run", () => {
    render(
      <ChatInputBar
        input=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        sessionId="session-1"
        runId="run_model_choice"
      />,
    );

    expect(useProviderStoreModule.useProviderStore).toHaveBeenCalledWith(
      "run_model_choice",
    );
  });

  describe("idle switch warning", () => {
    it("does not show warning on initial render", () => {
      render(
        <ChatInputBar
          input=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          sessionId="session-1"
          hasMessages
        />,
      );

      expect(screen.queryByText(IDLE_SWITCH_WARNING)).toBeNull();
    });

    it("shows warning with exact copy after idle model switch when thread has messages", async () => {
      render(
        <ChatInputBar
          input=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          sessionId="session-1"
          hasMessages
        />,
      );

      const trigger = screen.getByLabelText("Open model picker");
      fireEvent.click(trigger);

      const modelOption = await screen.findByText("GPT-4o");
      fireEvent.click(modelOption);

      await waitFor(() => {
        expect(screen.getByText(IDLE_SWITCH_WARNING)).toBeTruthy();
      });
    });

    it("auto-dismisses warning after 4 seconds", async () => {
      render(
        <ChatInputBar
          input=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          sessionId="session-1"
          hasMessages
        />,
      );

      const trigger = screen.getByLabelText("Open model picker");
      fireEvent.click(trigger);

      const modelOption = await screen.findByText("GPT-4o");
      fireEvent.click(modelOption);

      await waitFor(() => {
        expect(screen.getByText(IDLE_SWITCH_WARNING)).toBeTruthy();
      });

      await waitFor(
        () => {
          expect(screen.queryByText(IDLE_SWITCH_WARNING)).toBeNull();
        },
        { timeout: 5000 },
      );
    }, 12000);

    it("does not show warning when thread has no messages", async () => {
      render(
        <ChatInputBar
          input=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          sessionId="session-1"
          hasMessages={false}
        />,
      );

      const trigger = screen.getByLabelText("Open model picker");
      fireEvent.click(trigger);

      const modelOption = await screen.findByText("GPT-4o");
      fireEvent.click(modelOption);

      await waitFor(() => {
        expect(mockStore.applySessionSelection).toHaveBeenCalled();
      });

      expect(screen.queryByText(IDLE_SWITCH_WARNING)).toBeNull();
    });

    it("does not show warning during active run", () => {
      render(
        <ChatInputBar
          input=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          sessionId="session-1"
          hasMessages
          isLoading
        />,
      );

      expect(screen.queryByText(IDLE_SWITCH_WARNING)).toBeNull();
    });

    it("blocks model selection when an open picker becomes stoppable", async () => {
      const baseProps = {
        input: "",
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        sessionId: "session-1",
        hasMessages: true,
      };
      const { rerender } = render(<ChatInputBar {...baseProps} />);

      fireEvent.click(screen.getByLabelText("Open model picker"));
      const modelOption = await screen.findByText("GPT-4o");

      rerender(<ChatInputBar {...baseProps} onStop={vi.fn()} canStop />);
      fireEvent.click(modelOption);

      await waitFor(() => {
        expect(screen.getByText(ACTIVE_RUN_SWITCH_WARNING)).toBeTruthy();
      });
      expect(mockStore.applySessionSelection).not.toHaveBeenCalled();
    });
  });

  it("surfaces plan mode controls inside the composer options menu", () => {
    const onModeChange = vi.fn();

    render(
      <ChatInputBar
        input=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        sessionId="session-1"
        mode="build"
        onModeChange={onModeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open composer options" }));
    fireEvent.click(screen.getByRole("switch", { name: "Toggle plan mode" }));

    expect(onModeChange).toHaveBeenCalledWith("plan");
  });

  it("shows plan-mode guidance and lets users switch back to build", () => {
    const onModeChange = vi.fn();

    render(
      <ChatInputBar
        input=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        sessionId="session-1"
        mode="plan"
        onModeChange={onModeChange}
      />,
    );

    expect(
      screen.getByPlaceholderText(
        "Inspect the codebase and outline a safe plan without executing changes",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Plan mode inspects and outlines steps without running normal mutating execution.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Build" }));

    expect(onModeChange).toHaveBeenCalledWith("build");
  });

  it("shows repo file suggestions for @ mentions and inserts the selected file", async () => {
    function Wrapper() {
      const [value, setValue] = useState("");

      return (
        <ChatInputBar
          input={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          sessionId="session-1"
          repoTree={[
            { path: "README.md", type: "blob", sha: "1" },
            {
              path: "apps/web/src/components/chat/ChatInputBar.tsx",
              type: "blob",
              sha: "2",
            },
          ]}
        />
      );
    }

    render(<Wrapper />);

    const textarea = screen.getByPlaceholderText(
      "Ask LegionCode anything, @ to add files, / for commands",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@rea", selectionStart: 4 } });

    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Repository files" })).toBeTruthy();
    expect(textarea).toHaveAttribute("aria-expanded", "true");

    fireEvent.mouseDown(screen.getByText("README.md"));

    await waitFor(() => {
      expect(textarea.value).toBe("@README.md ");
    });
  });

  it("inserts the basename for a unique nested file inline in the composer", async () => {
    function Wrapper() {
      const [value, setValue] = useState("");

      return (
        <ChatInputBar
          input={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          sessionId="session-1"
          repoTree={[
            {
              path: "src/components/dashboard/employer/form-fields/JobDescriptionFields.tsx",
              type: "blob",
              sha: "1",
            },
            { path: "README.md", type: "blob", sha: "2" },
          ]}
        />
      );
    }

    render(<Wrapper />);

    const textarea = screen.getByPlaceholderText(
      "Ask LegionCode anything, @ to add files, / for commands",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@jobd", selectionStart: 5 } });
    expect(await screen.findByText("src/components/dashboard/employer/form-fields/JobDescriptionFields.tsx")).toBeTruthy();
    fireEvent.mouseDown(
      screen.getByText(
        "src/components/dashboard/employer/form-fields/JobDescriptionFields.tsx",
      ),
    );

    await waitFor(() => {
      expect(textarea.value).toBe("@JobDescriptionFields.tsx ");
    });
  });

  it("keeps an existing inline file mention visible without rendering a duplicate chip row", () => {
    render(
      <ChatInputBar
        input="and review @README.md"
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        sessionId="session-1"
        repoTree={[{ path: "README.md", type: "blob", sha: "1" }]}
      />,
    );

    const textarea = screen.getByPlaceholderText(
      "Ask LegionCode anything, @ to add files, / for commands",
    ) as HTMLTextAreaElement;

    expect(textarea.value).toBe("and review @README.md");
    expect(screen.queryByLabelText("Remove README.md")).toBeNull();
  });

  it("keeps the highlighted option in sync with arrow-key navigation", async () => {
    function Wrapper() {
      const [value, setValue] = useState("");

      return (
        <ChatInputBar
          input={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          sessionId="session-1"
          repoTree={[
            { path: "README.md", type: "blob", sha: "1" },
            { path: "docs/guide.md", type: "blob", sha: "2" },
          ]}
        />
      );
    }

    render(<Wrapper />);

    const textarea = screen.getByPlaceholderText(
      "Ask LegionCode anything, @ to add files, / for commands",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });

    const options = screen.getAllByRole("option");
    const highlightedOption = options[1];

    expect(highlightedOption?.getAttribute("aria-selected")).toBe("true");
    expect(textarea.getAttribute("aria-activedescendant")).toBe(
      highlightedOption?.id,
    );
  });

  it("adds a separating space before inserting an @ trigger into existing text", async () => {
    function Wrapper() {
      const [value, setValue] = useState("add logging to");

      return (
        <ChatInputBar
          input={value}
          onChange={setValue}
          onSubmit={vi.fn()}
          sessionId="session-1"
        />
      );
    }

    render(<Wrapper />);

    const textarea = screen.getByPlaceholderText(
      "Ask LegionCode anything, @ to add files, / for commands",
    ) as HTMLTextAreaElement;

    await act(async () => {
      textarea.focus();
      textarea.setSelectionRange(14, 14);
      fireEvent.click(screen.getByRole("button", { name: "Open composer options" }));
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Add photos & files" }),
      );
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    });

    await waitFor(() => {
      expect(textarea.value).toBe("add logging to @");
    });
  });

  it("keeps unfinished attachment and voice controls hidden", () => {
    render(
      <ChatInputBar
        input=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        sessionId="session-1"
      />,
    );

    expect(screen.queryByTitle("Attach file")).toBeNull();
    expect(screen.queryByTitle("Voice input")).toBeNull();
  });

  it("allows sending selected review comments without freeform text", () => {
    const onSubmit = vi.fn();

    render(
      <ChatInputBar
        input=""
        onChange={vi.fn()}
        onSubmit={onSubmit}
        sessionId="session-1"
        reviewComments={[
          {
            id: "comment-1",
            filePath: "apps/web/src/App.tsx",
            line: 24,
            side: "right",
            note: "Extract this branch.",
            createdAt: new Date().toISOString(),
            linePreview: "if (isReady) {",
            selected: true,
            anchors: [
              {
                hunkIndex: 0,
                lineIndex: 0,
                rowKey: "0:0",
                newLineNumber: 24,
                side: "right",
                linePreview: "if (isReady) {",
              },
            ],
            primaryAnchor: {
              hunkIndex: 0,
              lineIndex: 0,
              rowKey: "0:0",
              newLineNumber: 24,
              side: "right",
              linePreview: "if (isReady) {",
            },
            selectionMode: "single",
            runId: "run-1",
            sessionId: "session-1",
            diffFingerprint: "fingerprint-1",
            stale: false,
            deliveryState: "draft",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Send message"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByText("App.tsx:24")).toBeTruthy();
  });
});
