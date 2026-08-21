import { describe, expect, it } from "vitest";
import { resolveModelLabel } from "./modelLabels";

describe("resolveModelLabel", () => {
  it("uses the canonical discovered provider name", () => {
    expect(
      resolveModelLabel("claude-opus-4-8", {
        "opencode-zen": [{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
      }),
    ).toBe("Claude Opus 4.8");
  });

  it("restores dotted Claude versions when discovery metadata is absent", () => {
    expect(resolveModelLabel("claude-opus-4-8", {})).toBe("claude opus 4.8");
  });
});
