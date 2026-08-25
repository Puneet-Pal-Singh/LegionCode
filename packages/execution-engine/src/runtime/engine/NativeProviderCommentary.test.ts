import { describe, expect, it } from "vitest";
import { resolveModelCommentary } from "./NativeProviderCommentary.js";

describe("native provider commentary", () => {
  it("preserves model-written commentary", () => {
    expect(resolveModelCommentary(" I’ll inspect the route first. ")).toBe(
      "I’ll inspect the route first.",
    );
  });

  it("keeps a final response without tools free of fabricated commentary", () => {
    expect(resolveModelCommentary("")).toBeNull();
  });

  it("adds a concise harness fallback when a model omits tool commentary", () => {
    expect(
      resolveModelCommentary("", [
        { toolName: "glob" },
        { toolName: "read_file" },
      ]),
    ).toBe("I’ll inspect the relevant project files next.");
  });

  it("prefers mutation intent for a mixed tool batch", () => {
    expect(
      resolveModelCommentary("", [
        { toolName: "read_file" },
        { toolName: "apply_patch" },
      ]),
    ).toBe("I’ll update the relevant files next.");
  });
});
