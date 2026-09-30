import { describe, expect, it } from "vitest";
import {
  decodeThreadTitle,
  normalizeGeneratedTitle,
} from "./ThreadTitleOutput";

describe("thread title output", () => {
  it.each([
    "Create dark mode toggle",
    "Generate PDF invoices",
    "Fix login timeout",
    "Fix models.ts 400s",
    "User service refactor",
    "Fix chat title generation",
    "Create title generation tests",
    "लॉगिन टाइमआउट ठीक करें",
  ])("accepts a useful task title: %s", (title) => {
    expect(normalizeGeneratedTitle(title)).toBe(title);
    expect(normalizeGeneratedTitle({ title })).toBe(title);
  });

  it("accepts one strict JSON envelope and minimal text wrappers", () => {
    expect(normalizeGeneratedTitle('{"title":"Fix login timeout"}')).toBe(
      "Fix login timeout",
    );
    expect(normalizeGeneratedTitle('Title: "Fix login timeout."')).toBe(
      "Fix login timeout",
    );
    expect(
      normalizeGeneratedTitle(
        "<think>Private reasoning</think>Fix login timeout",
      ),
    ).toBe("Fix login timeout");
  });

  it.each([
    ["", "empty_output"],
    ["\n\t", "empty_output"],
    ["Fix login\nAnother title", "multiline_output"],
    ["We need to output a title\n\nFix login", "multiline_output"],
    ["Create a title for this conversation", "meta_narration"],
    ["Return only one plain-text title", "meta_narration"],
    ["User's goal: Get docs feedback", "meta_narration"],
    ["* User wants me to check readme", "meta_narration"],
    ["<think>unfinished reasoning", "malformed_output"],
    ["```\nFix login\n```", "malformed_output"],
    ['{"title":"Fix login","reason":"because"}', "malformed_output"],
    ['{"title":17}', "malformed_output"],
    ['{"title":"Fix login"', "malformed_output"],
    ["x".repeat(51), "title_too_long"],
  ])("rejects invalid output with a correction reason", (value, reason) => {
    expect(decodeThreadTitle(value)).toEqual({ ok: false, reason });
  });

  it("does not truncate Unicode or technical identifiers", () => {
    expect(normalizeGeneratedTitle("🚀".repeat(50))).toBe("🚀".repeat(50));
    expect(decodeThreadTitle("🚀".repeat(51))).toEqual({
      ok: false,
      reason: "title_too_long",
    });
    expect(
      normalizeGeneratedTitle(
        "Investigate very-long-authentication-service.ts timeout",
      ),
    ).toBeNull();
  });
});
