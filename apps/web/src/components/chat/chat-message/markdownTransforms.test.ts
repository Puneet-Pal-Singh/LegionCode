import { describe, expect, it } from "vitest";
import {
  extractMessageText,
  parseThinkingTags,
  shortenTextMentions,
  stripAssistantChangeCounts,
} from "./markdownTransforms";

describe("chat message markdown transforms", () => {
  it("extracts visible text while excluding typed reasoning parts", () => {
    expect(
      extractMessageText([
        { type: "reasoning", text: "hidden" },
        { type: "text", text: "visible" },
        { type: "thinking", text: "also hidden" },
      ]),
    ).toBe("visible");
  });

  it("removes thinking tags without changing surrounding content", () => {
    expect(
      parseThinkingTags("before\n<thinking>internal</thinking>\nafter"),
    ).toEqual({
      visibleContent: "before\n\nafter",
      thinkingBlocks: ["internal"],
    });
  });

  it("shortens file mentions without changing unrelated text", () => {
    expect(
      shortenTextMentions(
        'edit @src/components/App.tsx and @"docs/API Guide.md"',
      ),
    ).toBe("edit @App.tsx and @API Guide.md");
  });

  it("strips grounded change counts only when requested by the caller", () => {
    expect(stripAssistantChangeCounts("Changed app.ts (+2 -1)")).toBe(
      "Changed app.ts",
    );
  });
});
