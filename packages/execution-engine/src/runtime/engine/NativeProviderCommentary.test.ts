import { describe, expect, it } from "vitest";
import { resolveModelCommentary } from "./NativeProviderCommentary.js";

describe("native provider commentary", () => {
  it("preserves model-written commentary", () => {
    expect(resolveModelCommentary(" I’ll inspect the route first. ")).toBe(
      "I’ll inspect the route first.",
    );
  });

  it("does not fabricate commentary for a tool-only model response", () => {
    expect(resolveModelCommentary("")).toBeNull();
  });
});
