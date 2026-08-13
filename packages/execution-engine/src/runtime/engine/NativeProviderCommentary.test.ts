import { describe, expect, it } from "vitest";
import { resolveToolStepCommentary } from "./NativeProviderCommentary.js";

describe("native provider commentary", () => {
  it("preserves model-written commentary", () => {
    expect(
      resolveToolStepCommentary(" I’ll inspect the route first. ", [
        { id: "call-1", toolName: "read_file", args: { path: "app.ts" } },
      ]),
    ).toBe("I’ll inspect the route first.");
  });

  it("provides visible runtime progress when a model emits only a tool call", () => {
    expect(
      resolveToolStepCommentary("", [
        { id: "call-1", toolName: "read_file", args: { path: "app.ts" } },
      ]),
    ).toBe("Reading file contents from app.ts.");
  });
});
