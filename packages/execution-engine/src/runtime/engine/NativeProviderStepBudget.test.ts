import { describe, expect, it } from "vitest";
import {
  getNativeToolCallSafetyLimit,
  shouldForceNativeFinalSynthesis,
} from "./NativeProviderStepBudget";

describe("NativeProviderStepBudget", () => {
  it("reserves the last model step for final synthesis", () => {
    expect(shouldForceNativeFinalSynthesis(23, 25)).toBe(false);
    expect(shouldForceNativeFinalSynthesis(24, 25)).toBe(true);
  });

  it("keeps the independent tool-call guard above the model-step budget", () => {
    expect(getNativeToolCallSafetyLimit(25)).toBe(400);
    expect(getNativeToolCallSafetyLimit(2)).toBe(100);
  });
});
