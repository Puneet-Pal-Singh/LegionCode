import { describe, expect, it } from "vitest";
import {
  assertChatImageModelSupport,
  assertSubmittedImageModelSupport,
} from "./ChatImageModelPolicy";

describe("server-owned image model admission", () => {
  it("accepts declared image input and gives modality metadata precedence over vision flags", () => {
    expect(() =>
      assertChatImageModelSupport({ inputModalities: { image: true } }),
    ).not.toThrow();
    expect(() =>
      assertChatImageModelSupport({ capabilities: { supportsVision: true } }),
    ).not.toThrow();
    expect(() =>
      assertChatImageModelSupport({
        inputModalities: { image: false },
        capabilities: { supportsVision: true },
      }),
    ).toThrow("Select a model");
  });
  it("rejects unsupported and unknown image capabilities without affecting text-only input", () => {
    expect(() =>
      assertChatImageModelSupport({ capabilities: { supportsVision: false } }),
    ).toThrow("Select a model");
    expect(() => assertChatImageModelSupport({})).toThrow(
      "could not be verified",
    );
    expect(() =>
      assertSubmittedImageModelSupport([{ role: "user", content: "text" }], {}),
    ).not.toThrow();
  });
});
