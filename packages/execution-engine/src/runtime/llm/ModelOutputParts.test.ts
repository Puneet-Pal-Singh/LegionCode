import { describe, expect, it } from "vitest";
import {
  getVisibleModelText,
  normalizeModelOutputParts,
} from "./ModelOutputParts.js";

describe("ModelOutputParts", () => {
  it("normalizes plain provider text as visible text", () => {
    const parts = normalizeModelOutputParts({ text: "Done.\n\nReady." });

    expect(parts).toEqual([{ type: "visible_text", text: "Done.\n\nReady." }]);
    expect(getVisibleModelText(parts)).toBe("Done.\n\nReady.");
  });

  it("keeps tagged reasoning out of visible text", () => {
    const parts = normalizeModelOutputParts({
      text: "<thinking>private plan</thinking>\nDone. The edit is complete.",
    });

    expect(parts).toEqual([
      {
        type: "reasoning",
        text: "private plan",
        visibility: "audit_only",
        reason: "provider_internal_tag",
      },
      { type: "visible_text", text: "Done. The edit is complete." },
    ]);
    expect(getVisibleModelText(parts)).toBe("Done. The edit is complete.");
  });

  it("rejects dense labeled planning outlines as audit-only reasoning", () => {
    const parts = normalizeModelOutputParts({
      text: [
        '• User says: "check my hero"',
        "• Context: request is about a hero section.",
        "• Direct answer: I need the file first.",
        "• Helpful details: Ask for a screenshot.",
      ].join("\n"),
    });

    expect(parts).toEqual([
      {
        type: "reasoning",
        text: [
          '• User says: "check my hero"',
          "• Context: request is about a hero section.",
          "• Direct answer: I need the file first.",
          "• Helpful details: Ask for a screenshot.",
        ].join("\n"),
        visibility: "audit_only",
        reason: "dense_labeled_outline",
      },
    ]);
    expect(getVisibleModelText(parts)).toBe("");
  });

  it("records tool calls and usage as typed non-text parts", () => {
    const parts = normalizeModelOutputParts({
      text: "I will inspect that.",
      toolCalls: [{ id: "tool-1", toolName: "read_file", args: { path: "README.md" } }],
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cost: 0,
        provider: "test",
        model: "test-model",
      },
    });

    expect(parts.map((part) => part.type)).toEqual([
      "visible_text",
      "tool_call",
      "usage",
    ]);
    expect(getVisibleModelText(parts)).toBe("I will inspect that.");
  });
});
