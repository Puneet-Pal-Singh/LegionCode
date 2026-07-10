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

  it("does not classify untagged labeled text as internal reasoning", () => {
    const text = [
      '• User says: "check my hero"',
      "• Context: request is about a hero section.",
      "• Direct answer: I need the file first.",
      "• Helpful details: Ask for a screenshot.",
    ].join("\n");
    const parts = normalizeModelOutputParts({ text });
    const visible = getVisibleModelText(parts);

    expect(parts[0]?.type).toBe("visible_text");
    expect(visible).toContain("check my hero");
    expect(visible).toContain("Direct answer");
  });

  it("preserves ordinary final text even when it uses answer-style labels", () => {
    const parts = normalizeModelOutputParts({
      text: "Direct answer: updated the hero copy.",
    });

    expect(parts).toEqual([
      { type: "visible_text", text: "Direct answer: updated the hero copy." },
    ]);
    expect(getVisibleModelText(parts)).toBe(
      "Direct answer: updated the hero copy.",
    );
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
