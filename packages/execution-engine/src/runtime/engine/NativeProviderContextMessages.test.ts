import { describe, expect, it } from "vitest";
import type { CoreMessage } from "ai";
import { ContextCompactionPayloadSchema } from "@repo/platform-protocol";
import {
  buildProviderContextMessages,
  estimateConversationTokens,
  estimateAttachmentTokens,
  summarizeConversationForCompaction,
} from "./NativeProviderContextMessages.js";

describe("NativeProviderContextMessages", () => {
  const messages = [
    { role: "user" as const, content: "first request" },
    { role: "assistant" as const, content: "first answer" },
    { role: "user" as const, content: "latest request" },
  ];

  it("uses compacted context plus the latest request", () => {
    expect(
      buildProviderContextMessages({
        messages,
        compactedContext: "preserved summary",
      }),
    ).toEqual([
      {
        role: "system",
        content: "Compacted conversation context:\npreserved summary",
      },
      { role: "user", content: "latest request" },
    ]);
  });

  it("estimates the complete conversation and preserves it in a bounded summary", () => {
    expect(estimateConversationTokens(messages)).toBeGreaterThan(1);
    expect(
      summarizeConversationForCompaction(messages, "latest request"),
    ).toContain("assistant: first answer");
  });
  it("retains original system instructions, historical images, and all active tool pairs", () => {
    const image: CoreMessage = {
      role: "user",
      content: [
        { type: "text", text: "Inspect this screenshot" },
        {
          type: "image",
          image: "data:image/png;base64,iVBORw0KGgo=",
          mimeType: "image/png",
        },
      ],
    };
    const system: CoreMessage = {
      role: "system",
      content: "Never remove existing tests",
    };
    const active: CoreMessage[] = [
      { role: "user", content: "Continue fixing that screenshot" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            args: { path: "app.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            result: "newly completed work",
          },
        ],
      },
    ];
    const result = buildProviderContextMessages({
      messages: [system, image, ...messages, ...active],
      compactedContext: "summary",
    });
    expect(result).toEqual([
      system,
      { role: "system", content: "Compacted conversation context:\nsummary" },
      image,
      ...active,
    ]);
    expect(summarizeConversationForCompaction(active, "Continue")).toContain(
      "newly completed work",
    );
  });

  it("counts visual inputs separately without counting or summarizing base64", () => {
    const image = (encoding: string): CoreMessage => ({
      role: "user",
      content: [
        { type: "text", text: "Keep the original instructions" },
        {
          type: "image",
          image: `data:image/png;base64,${encoding}`,
          mimeType: "image/png",
        },
      ],
    });
    const small = [image("iVBORw0KGgo=")];
    const large = [image("A".repeat(Math.ceil((1024 * 1024 * 4) / 3)))];
    expect(estimateConversationTokens(large)).toBe(
      estimateConversationTokens(small),
    );
    expect(estimateConversationTokens(large)).toBeLessThan(100);
    expect(estimateAttachmentTokens(large)).toBeGreaterThan(0);
    expect(estimateAttachmentTokens(large)).toBe(
      estimateAttachmentTokens(small),
    );
    const summary = summarizeConversationForCompaction(large, "Analyze");
    expect(summary).toContain("Keep the original instructions");
    expect(summary).toContain("[Image attached: image/png]");
    expect(summary).not.toContain("base64");
    expect(summary).not.toContain("AAAA");
  });

  it("bounds the complete summary including a long prompt to the lifecycle contract", () => {
    const summary = summarizeConversationForCompaction(
      [
        { role: "user", content: "original instruction " + "x".repeat(20_000) },
        { role: "assistant", content: "latest progress" },
      ],
      "long request ".repeat(2_000),
    );
    expect(summary).toContain("original instruction");
    expect(summary).toContain("latest progress");
    expect(
      ContextCompactionPayloadSchema.parse({
        compactionId: "cmp_test",
        itemId: "itm_compaction01",
        mode: "automatic",
        phase: "compacted",
        preservedContextReference: "context:test",
        summary,
        error: null,
      }).summary,
    ).toHaveLength(4_000);
  });
});
