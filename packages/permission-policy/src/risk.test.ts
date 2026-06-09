import { describe, expect, it } from "vitest";
import { classifyToolAction } from "./risk.js";

describe("classifyToolAction", () => {
  it("classifies secret access as critical", () => {
    const risk = classifyToolAction({
      domain: "secret",
      action: "read token",
    });

    expect(risk.level).toBe("critical");
    expect(risk.categories).toContain("secret_access");
  });

  it("classifies git inspection separately from git mutation", () => {
    expect(
      classifyToolAction({ domain: "git", action: "status" }).level,
    ).toBe("low");
    expect(classifyToolAction({ domain: "git", action: "commit" }).level).toBe(
      "high",
    );
  });

  it("classifies network actions as high risk", () => {
    const risk = classifyToolAction({ domain: "network", action: "fetch" });

    expect(risk.level).toBe("high");
    expect(risk.requiresApproval).toBe(true);
  });
});
