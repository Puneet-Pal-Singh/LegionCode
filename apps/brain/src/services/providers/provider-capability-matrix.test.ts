import { describe, expect, it } from "vitest";
import { PROVIDER_IDS } from "@repo/provider-core";
import {
  PROVIDER_CAPABILITY_MATRIX,
  isModelAllowedByCapabilityMatrix,
} from "./provider-capability-matrix";
import type { ProviderId } from "@repo/shared-types";

describe("provider-capability-matrix", () => {
  it("creates capability entries for every registered provider", () => {
    for (const providerId of PROVIDER_IDS as readonly ProviderId[]) {
      expect(PROVIDER_CAPABILITY_MATRIX[providerId]).toBeDefined();
    }
  });

  it("returns true for known provider/model combinations", () => {
    expect(isModelAllowedByCapabilityMatrix("openai", "gpt-4o")).toBe(true);
  });

  it("returns false for unknown provider/model combinations", () => {
    expect(
      isModelAllowedByCapabilityMatrix("openai", "llama-3.3-70b-versatile"),
    ).toBe(false);
  });
});
