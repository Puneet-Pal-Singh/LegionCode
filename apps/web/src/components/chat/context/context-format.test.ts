import { describe, expect, it } from "vitest";
import { formatCompactTokenCount, formatCost } from "./context-format";

describe("context formatting", () => {
  it("uses k and M suffixes at the correct scale", () => {
    expect(formatCompactTokenCount(999)).toBe("999");
    expect(formatCompactTokenCount(17_475)).toBe("17.5k");
    expect(formatCompactTokenCount(258_000)).toBe("258k");
    expect(formatCompactTokenCount(1_000_000)).toBe("1M");
    expect(formatCompactTokenCount(1_050_000)).toBe("1.05M");
  });

  it("keeps sub-cent costs visible", () => {
    expect(formatCost(0.0096)).toBe("$0.0096");
    expect(formatCost(5.7)).toBe("$5.70");
  });
});
