import { describe, expect, it } from "vitest";
import { JsonRecordSchema } from "./common.js";

describe("JsonRecordSchema", () => {
  it("rejects values that cannot cross a JSON protocol boundary", () => {
    expect(() =>
      JsonRecordSchema.parse({
        createdAt: new Date("2026-06-09T12:00:00.000Z"),
      }),
    ).toThrow();
    expect(() =>
      JsonRecordSchema.parse({
        missing: undefined,
      }),
    ).toThrow();
    expect(() =>
      JsonRecordSchema.parse({
        unsafeNumber: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
  });
});
