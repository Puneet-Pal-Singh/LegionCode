import { describe, expect, it } from "vitest";
import {
  shortenTextMentions,
  stripAssistantChangeCounts,
} from "./markdownTransforms";

describe("chat message markdown transforms", () => {
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
