import { describe, expect, it, vi } from "vitest";
import { InMemoryRunApprovalResolutionRegistry } from "./RunApprovalResolutionRegistry";

describe("InMemoryRunApprovalResolutionRegistry", () => {
  it("coalesces concurrent identical approval deliveries", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolve = vi.fn(async () => gate);
    const registry = new InMemoryRunApprovalResolutionRegistry();
    registry.register("trn_test" as never, resolve);

    const first = registry.resolve("trn_test" as never, "appr_test" as never, {
      decision: "approved",
      decidedBy: null,
      reason: null,
    });
    const second = registry.resolve("trn_test" as never, "appr_test" as never, {
      decision: "approved",
      decidedBy: null,
      reason: null,
    });
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledTimes(1);

    release();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});
