/**
 * ConnectProviderChooser Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectProviderChooser } from "./ConnectProviderChooser";
import { type ProviderRegistryEntry } from "@repo/shared-types";

describe("ConnectProviderChooser", () => {
  const mockCatalog: ProviderRegistryEntry[] = [
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
    {
      providerId: "anthropic",
      displayName: "Anthropic",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "anthropic-native",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: false,
        structuredOutputs: false,
      },
      modelSource: "static",
      keyFormat: {
        prefix: "sk-ant-",
        description: "Anthropic API key (starts with sk-ant-)",
      },
    },
    {
      providerId: "groq",
      displayName: "Groq",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "openai-compatible",
      capabilities: {
        streaming: true,
        tools: false,
        jsonMode: false,
        structuredOutputs: false,
      },
      modelSource: "remote",
    },
    {
      providerId: "axis",
      displayName: "Axis",
      authModes: ["platform_managed"],
      launchStage: "supported",
      adapterFamily: "openai-compatible",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "static",
    },
    {
      providerId: "google",
      displayName: "Google AI (Gemini)",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "google-native",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: false,
        structuredOutputs: true,
      },
      modelSource: "remote",
    },
    {
      providerId: "together",
      displayName: "Together AI",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "openai-compatible",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "remote",
    },
    {
      providerId: "cerebras",
      displayName: "Cerebras",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "openai-compatible",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "remote",
    },
    {
      providerId: "opencode-go",
      displayName: "OpenCode Go",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "openai-compatible",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "remote",
    },
    {
      providerId: "opencode-zen",
      displayName: "OpenCode Zen",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "custom-http",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "remote",
    },
    {
      providerId: "cloudflare-ai",
      displayName: "Cloudflare AI",
      authModes: ["api_key"],
      launchStage: "supported",
      adapterFamily: "custom-http",
      capabilities: {
        streaming: true,
        tools: true,
        jsonMode: true,
        structuredOutputs: true,
      },
      modelSource: "remote",
    },
  ];

  const mockHandlers = {
    onConnect: vi.fn(async () => {}),
    onErrorClear: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders provider search and list", () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    expect(
      screen.getByPlaceholderText(/search providers/i),
    ).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("Groq")).toBeInTheDocument();
    expect(screen.getByText("Google AI (Gemini)")).toBeInTheDocument();
    expect(screen.getByText("Together AI")).toBeInTheDocument();
    expect(screen.getByText("Cerebras")).toBeInTheDocument();
    expect(screen.getByText("OpenCode Go")).toBeInTheDocument();
    expect(screen.getByText("OpenCode Zen")).toBeInTheDocument();
    expect(screen.getByText("Cloudflare AI")).toBeInTheDocument();
    expect(screen.queryByText("Axis")).not.toBeInTheDocument();
  });

  it("excludes Axis from connect list even if auth mode is misconfigured", () => {
    const misconfiguredCatalog = mockCatalog.map((entry) =>
      entry.providerId === "axis"
        ? {
            ...entry,
            authModes: ["api_key"] as Array<
              "api_key" | "oauth" | "platform_managed"
            >,
          }
        : entry,
    );

    render(
      <ConnectProviderChooser
        catalog={misconfiguredCatalog}
        {...mockHandlers}
      />,
    );

    expect(screen.queryByText("Axis")).not.toBeInTheDocument();
  });

  it("excludes hidden launch providers from the connect list", () => {
    const hiddenCatalog = mockCatalog.map((entry) =>
      entry.providerId === "google"
        ? { ...entry, launchStage: "hidden" as const }
        : entry,
    );

    render(
      <ConnectProviderChooser catalog={hiddenCatalog} {...mockHandlers} />,
    );

    expect(screen.queryByText("Google AI (Gemini)")).not.toBeInTheDocument();
  });

  it("filters providers by query", () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    const input = screen.getByPlaceholderText(/search providers/i);
    fireEvent.change(input, { target: { value: "openai" } });

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
  });

  it("shows no matches state", () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    const input = screen.getByPlaceholderText(/search providers/i);
    fireEvent.change(input, { target: { value: "nonexistent" } });

    expect(
      screen.getByText(/no providers match your search/i),
    ).toBeInTheDocument();
  });

  it("moves to API key step after provider selection", async () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    fireEvent.click(screen.getByText("OpenAI"));

    await waitFor(() => {
      expect(screen.getByText(/connect openai/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/api key/i)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /back to providers/i }),
      ).toBeInTheDocument();
    });
  });

  it("returns to provider list on back", async () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    fireEvent.click(screen.getByText("OpenAI"));
    const backButton = await screen.findByRole("button", {
      name: /back to providers/i,
    });

    fireEvent.click(backButton);

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/search providers/i),
      ).toBeInTheDocument();
    });
  });

  it("requires API key before submit", async () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    fireEvent.click(screen.getByText("OpenAI"));

    const submitButton = await screen.findByRole("button", { name: /submit/i });
    expect(submitButton).toBeDisabled();
  });

  it("submits provider ID and API key", async () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    fireEvent.click(screen.getByText("OpenAI"));

    const keyInput = await screen.findByPlaceholderText(/api key/i);
    fireEvent.change(keyInput, { target: { value: "sk-test-key" } });

    const submitButton = screen.getByRole("button", { name: /submit/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockHandlers.onConnect).toHaveBeenCalledWith(
        "openai",
        "sk-test-key",
      );
    });
  });

  it("submits Workers AI connection config for Cloudflare AI", async () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    fireEvent.click(screen.getByText("Cloudflare AI"));

    fireEvent.change(await screen.findByLabelText(/cloudflare account id/i), {
      target: { value: "account_123" },
    });
    fireEvent.change(screen.getByLabelText(/cloudflare ai api key/i), {
      target: { value: "cf-test-token-12345" },
    });

    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => {
      expect(mockHandlers.onConnect).toHaveBeenCalledWith(
        "cloudflare-ai",
        "cf-test-token-12345",
        undefined,
        {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          gatewayId: undefined,
          routeMode: "workers-ai-direct",
        },
      );
    });
  });

  it("requires gateway name for Cloudflare AI Gateway connections", async () => {
    render(<ConnectProviderChooser catalog={mockCatalog} {...mockHandlers} />);

    fireEvent.click(screen.getByText("Cloudflare AI"));
    fireEvent.click(await screen.findByRole("button", { name: /ai gateway/i }));
    fireEvent.change(screen.getByLabelText(/cloudflare account id/i), {
      target: { value: "account_123" },
    });
    fireEvent.change(screen.getByLabelText(/cloudflare ai api key/i), {
      target: { value: "cf-test-token-12345" },
    });

    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/ai gateway name/i), {
      target: { value: "my-gateway" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));

    await waitFor(() => {
      expect(mockHandlers.onConnect).toHaveBeenCalledWith(
        "cloudflare-ai",
        "cf-test-token-12345",
        undefined,
        {
          providerId: "cloudflare-ai",
          accountId: "account_123",
          gatewayId: "my-gateway",
          routeMode: "ai-gateway",
        },
      );
    });
  });

  it("shows submitting state", async () => {
    const { rerender } = render(
      <ConnectProviderChooser
        catalog={mockCatalog}
        isConnecting={false}
        {...mockHandlers}
      />,
    );

    fireEvent.click(screen.getByText("OpenAI"));

    rerender(
      <ConnectProviderChooser
        catalog={mockCatalog}
        isConnecting={true}
        {...mockHandlers}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/submitting/i)).toBeInTheDocument();
    });
  });

  it("shows error state", () => {
    render(
      <ConnectProviderChooser
        catalog={mockCatalog}
        error="Invalid API key format"
        {...mockHandlers}
      />,
    );

    expect(screen.getByText(/invalid api key format/i)).toBeInTheDocument();
  });

  it("shows success state", () => {
    render(
      <ConnectProviderChooser
        catalog={mockCatalog}
        success="Provider connected successfully"
        {...mockHandlers}
      />,
    );

    expect(
      screen.getByText(/provider connected successfully/i),
    ).toBeInTheDocument();
  });

  it("shows empty catalog message", () => {
    render(<ConnectProviderChooser catalog={[]} {...mockHandlers} />);

    expect(screen.getByText(/no providers available/i)).toBeInTheDocument();
  });
});
