import { describe, expect, it } from "vitest";
import {
  buildNativeProviderStructuredFinal,
  NativeProviderFinalAnswerSchema,
} from "./NativeProviderStructuredFinal.js";

describe("NativeProviderStructuredFinal", () => {
  it("requires a non-empty typed final answer", () => {
    expect(
      NativeProviderFinalAnswerSchema.parse({ finalAnswer: " OK " }),
    ).toEqual({ finalAnswer: "OK" });
    expect(() =>
      NativeProviderFinalAnswerSchema.parse({ finalAnswer: " " }),
    ).toThrow();
  });

  it("creates an explicit visible final transcript part", () => {
    expect(
      buildNativeProviderStructuredFinal({
        runId: "run-1",
        turnId: "turn-1",
        finalAnswer: "OK",
        sequence: 0,
        createdAt: "2026-07-28T00:00:00.000Z",
      }),
    ).toMatchObject({
      type: "final",
      visibility: "visible",
      text: "OK",
    });
  });
});
