// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRegistryEntry } from "@repo/shared-types";
import { ConnectProviderChooser } from "./ConnectProviderChooser.js";

const catalog: ProviderRegistryEntry[] = [
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
  },
];

describe("ConnectProviderChooser", () => {
  afterEach(cleanup);

  it("clears the secret after a successful connect settles", async () => {
    let settleConnect!: () => void;
    const onConnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleConnect = resolve;
        }),
    );

    render(<ConnectProviderChooser catalog={catalog} onConnect={onConnect} />);
    fireEvent.click(screen.getByText("OpenAI"));
    const secretInput = await screen.findByLabelText("OpenAI API key");
    fireEvent.change(secretInput, { target: { value: "sk-ephemeral-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    expect((secretInput as HTMLInputElement).value).toBe("sk-ephemeral-secret");
    settleConnect();
    await waitFor(() => expect((secretInput as HTMLInputElement).value).toBe(""));
  });

  it("clears the secret after a failed connect settles", async () => {
    const onConnect = vi.fn(async () => {
      throw new Error("credential rejected");
    });

    render(<ConnectProviderChooser catalog={catalog} onConnect={onConnect} />);
    fireEvent.click(screen.getByText("OpenAI"));
    const secretInput = await screen.findByLabelText("OpenAI API key");
    fireEvent.change(secretInput, { target: { value: "sk-ephemeral-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((secretInput as HTMLInputElement).value).toBe(""));
  });
});
