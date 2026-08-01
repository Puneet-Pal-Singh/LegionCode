import { describe, expect, it } from "vitest";
import { buildNativeProviderMessages } from "./NativeProviderFinalRecoveryMessages.js";

describe("buildNativeProviderMessages", () => {
  it("leaves the normal task call unchanged", () => {
    const messages = [{ role: "user" as const, content: "Say OK." }];
    expect(buildNativeProviderMessages(messages, 0)).toEqual(messages);
  });

  it("adds a direct user-level response contract for final recovery", () => {
    const messages = [{ role: "user" as const, content: "Say OK." }];
    const recovered = buildNativeProviderMessages(messages, 1);

    expect(recovered).toHaveLength(2);
    expect(recovered[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Output only the answer"),
    });
  });
});
