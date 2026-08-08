import { describe, expect, it } from "vitest";
import { parseRunReasoningEffort } from "./RunEngine.js";

describe("parseRunReasoningEffort", () => {
  it("preserves an omitted effort as undefined", () => {
    expect(parseRunReasoningEffort(undefined)).toBeUndefined();
  });

  it("rejects an invalid effort instead of silently dropping it", () => {
    expect(() =>
      parseRunReasoningEffort({ reasoningEffort: 42 } as never),
    ).toThrow(/Invalid reasoning effort/);
  });
});
