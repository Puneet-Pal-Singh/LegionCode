import { describe, expect, it } from "vitest";
import { truncateUtf8, utf8ByteLength } from "./Utf8Text";

describe("Utf8Text", () => {
  it("counts UTF-8 bytes instead of JavaScript characters", () => {
    expect(utf8ByteLength("aé漢")).toBe(6);
  });

  it("keeps truncated text within the complete byte budget", () => {
    const result = truncateUtf8("漢".repeat(20), 23, "\n[cut]");

    expect(result.truncated).toBe(true);
    expect(utf8ByteLength(result.value)).toBeLessThanOrEqual(23);
    expect(result.value).not.toContain("�");
  });
});
