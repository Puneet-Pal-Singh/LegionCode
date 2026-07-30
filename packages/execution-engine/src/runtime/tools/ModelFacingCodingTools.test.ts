import { describe, expect, it } from "vitest";
import { isModelFacingCodingTool } from "./ModelFacingCodingTools.js";

describe("model-facing coding tools", () => {
  it("keeps multi_edit replayable without offering it to new model turns", () => {
    expect(isModelFacingCodingTool("multi_edit")).toBe(false);
    expect(isModelFacingCodingTool("apply_patch")).toBe(true);
    expect(isModelFacingCodingTool("edit_file")).toBe(true);
    expect(isModelFacingCodingTool("write_file")).toBe(true);
  });
});
