import { describe, expect, it } from "vitest";
import { resolveModelCommentary } from "./NativeProviderCommentary.js";

describe("native provider commentary", () => {
  it("preserves model-written commentary", () => {
    expect(resolveModelCommentary(" The provider route differs. ")).toBe(
      "The provider route differs.",
    );
  });

  it("keeps a final response without tools free of fabricated commentary", () => {
    expect(resolveModelCommentary("")).toBeNull();
  });

  it("does not invent progress text when a model emits only tool calls", () => {
    expect(resolveModelCommentary("")).toBeNull();
  });
});
