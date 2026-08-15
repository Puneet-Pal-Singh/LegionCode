import { describe, expect, it } from "vitest";
import {
  LegacyProviderTranscriptPartNormalizer,
  finalizeTranscriptParts,
  visibleTextFromTranscriptParts,
} from "./TranscriptPartNormalizer.js";

const input = {
  runId: "run_1",
  turnId: "turn_1",
  providerId: "legacy-provider",
  createdAt: "2026-07-10T00:00:00.000Z",
};

describe("TranscriptPartNormalizer", () => {
  const normalizer = new LegacyProviderTranscriptPartNormalizer();

  it("keeps tagged reasoning and tool calls out of visible output", () => {
    const parts = normalizer.normalize({
      ...input,
      providerText: "<thinking>private plan</thinking>Done.",
      toolCalls: [
        { id: "call_1", toolName: "read_file", args: { path: "README.md" } },
      ],
    });

    expect(parts.map((part) => part.type)).toEqual([
      "reasoning",
      "visible_text",
      "raw_provider_material",
      "tool_call",
    ]);
    expect(visibleTextFromTranscriptParts(parts)).toBe("Done.");
  });

  it("quarantines legacy labeled planning outlines without making labels final", () => {
    const parts = normalizer.normalize({
      ...input,
      providerText: [
        "User says: inspect the hero",
        "Intent: review the page",
        "Context: the page is in src/App.tsx",
        "Direct Answer: I need to inspect it first",
      ].join("\n"),
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]?.type).toBe("reasoning");
    expect(visibleTextFromTranscriptParts(parts)).toBe("");
  });

  it("quarantines unstructured tool JSON as audit-only reasoning", () => {
    const parts = normalizer.normalize({
      ...input,
      providerText: '{"tool":"read_file","arguments":{"path":"README.md"}}',
    });

    expect(parts.some((part) => part.type === "reasoning")).toBe(true);
    expect(visibleTextFromTranscriptParts(parts)).toBe("");
  });

  it("quarantines high-confidence legacy internal deliberation", () => {
    const parts = normalizer.normalize({
      ...input,
      providerText: "The user wants a greeting. I should answer briefly.Hello!",
    });

    expect(parts[0]).toMatchObject({
      type: "reasoning",
      visibility: "audit_only",
      reason: "legacy_internal_deliberation_quarantine",
    });
    expect(visibleTextFromTranscriptParts(parts)).toBe("");
  });

  it("quarantines third-person user narration even without an explicit plan", () => {
    const parts = normalizer.normalize({
      ...input,
      providerText:
        "The user wants the final directory name. The output was /tmp/example.example",
    });

    expect(parts[0]).toMatchObject({
      type: "reasoning",
      visibility: "audit_only",
      reason: "legacy_internal_deliberation_quarantine",
    });
    expect(visibleTextFromTranscriptParts(parts)).toBe("");
  });

  it("uses structured provider parts and emits typed usage/error parts", () => {
    const parts = normalizer.normalize({
      ...input,
      providerParts: [{ type: "final", text: "Finished." }],
      providerText: "ignored raw text",
      outputIntent: "final",
      usage: {
        provider: "legacy-provider",
        model: "model_1",
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      },
      finishReason: "length",
    });

    expect(parts.map((part) => part.type)).toEqual(["final", "usage", "error"]);
    expect(visibleTextFromTranscriptParts(parts)).toBe("Finished.");
  });

  it("retains provider text when structured parts contain only private reasoning", () => {
    const parts = normalizer.normalize({
      ...input,
      providerParts: [
        {
          type: "reasoning",
          text: "Private provider reasoning",
          reason: "provider_reasoning",
        },
      ],
      providerText: "OK.",
      outputIntent: "final",
    });

    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          visibility: "audit_only",
          text: "Private provider reasoning",
        }),
        expect.objectContaining({
          type: "final",
          visibility: "visible",
          text: "OK.",
        }),
      ]),
    );
    expect(visibleTextFromTranscriptParts(parts)).toBe("OK.");
  });

  it("preserves visible provider commentary beside private reasoning", () => {
    const parts = normalizer.normalize({
      ...input,
      providerParts: [
        {
          type: "reasoning",
          text: "Private provider reasoning",
          reason: "provider_reasoning",
        },
        { type: "visible_text", text: "I’ll inspect the route first." },
      ],
      outputIntent: "intermediate",
    });

    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          visibility: "audit_only",
          text: "Private provider reasoning",
        }),
        expect.objectContaining({
          type: "visible_text",
          visibility: "visible",
          text: "I’ll inspect the route first.",
        }),
      ]),
    );
    expect(visibleTextFromTranscriptParts(parts)).toBe(
      "I’ll inspect the route first.",
    );
  });

  it("quarantines provider final markers until runtime declares terminal output", () => {
    const parts = normalizer.normalize({
      ...input,
      providerParts: [{ type: "final", text: "Intermediate." }],
      toolCalls: [
        { id: "call_1", toolName: "read_file", args: { path: "README.md" } },
      ],
    });

    expect(parts[0]).toMatchObject({
      type: "visible_text",
      finalized: false,
      text: "Intermediate.",
    });
    expect(parts.some((part) => part.type === "final")).toBe(false);
  });

  it("translates an ordinary terminal provider reply into an explicit final part", () => {
    const parts = normalizer.normalize({
      ...input,
      providerText: "Hi there.",
      outputIntent: "final",
    });

    expect(parts.find((part) => part.type === "final")).toMatchObject({
      type: "final",
      text: "Hi there.",
      visibility: "visible",
    });
  });

  it("finalizes only visible text after runtime proves the response is terminal", () => {
    const parts = normalizer.normalize({
      ...input,
      providerText: "Ready.",
    });
    const finalized = finalizeTranscriptParts(parts);

    expect(finalized[0]?.type).toBe("final");
    expect(finalized.at(-1)?.type).toBe("raw_provider_material");
  });

  it("derives stable part IDs from the turn and provider correlation", () => {
    const request = {
      ...input,
      providerText: "Done.",
      toolCalls: [
        { id: "call_1", toolName: "read_file", args: { path: "README.md" } },
      ],
    };
    const first = normalizer.normalize(request).map((part) => part.id);
    const second = normalizer.normalize(request).map((part) => part.id);

    expect(second).toEqual(first);
  });
});
