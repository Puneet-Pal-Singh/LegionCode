import { describe, expect, it } from "vitest";
import { buildAdmissionScopeFingerprint } from "./RunAdmissionScopeFingerprint";

describe("buildAdmissionScopeFingerprint", () => {
  it("uses a SHA-256 fingerprint for admission scope seeds", async () => {
    const request = new Request("https://brain.local/chat", {
      headers: {
        "CF-Connecting-IP": "203.0.113.10",
        "User-Agent": "LegionCode-Test",
      },
    });

    const fingerprint = await buildAdmissionScopeFingerprint(request);

    expect(fingerprint).toMatch(/^fp-[a-f0-9]{64}$/);
  });
});
