import { describe, expect, it } from "vitest";
import { ProviderToolCallIdentityMap } from "./ProviderToolCallIdentityMap.js";

describe("ProviderToolCallIdentityMap", () => {
  it("returns the provider id for a protocol-safe tool call id", () => {
    const identities = new ProviderToolCallIdentityMap();
    identities.register("toolcall_call_abc123", "call_abc123");

    expect(identities.toProviderId("toolcall_call_abc123")).toBe(
      "call_abc123",
    );
  });

  it("keeps already-compatible ids unchanged", () => {
    const identities = new ProviderToolCallIdentityMap();

    expect(identities.toProviderId("toolcall_native123")).toBe(
      "toolcall_native123",
    );
  });
});
