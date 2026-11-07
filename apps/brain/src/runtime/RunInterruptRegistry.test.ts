import { claimExecutionWithStartupInterrupt } from "./RunExecutionStartup";
import { describe, expect, it, vi } from "vitest";
import { TurnIdSchema } from "@repo/platform-protocol";
import { InMemoryRunInterruptRegistry } from "./RunInterruptRegistry";

describe("InMemoryRunInterruptRegistry", () => {
  it("coalesces repeated in-flight interrupt requests for one turn", async () => {
    const registry = new InMemoryRunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const turnId = TurnIdSchema.parse("trn_123456");
    expect(await registry.request(turnId, "No owner yet.")).toBe(false);
    registry.beginStartup(turnId);
    expect(registry.hasActiveOwner(turnId)).toBe(true);
    expect(await registry.request(turnId, "User interrupted the turn.")).toBe(
      true,
    );
    expect(registry.register(turnId, interrupt)).toBe(
      "User interrupted the turn.",
    );

    await Promise.all([
      registry.request(turnId, "User interrupted the turn."),
      registry.request(turnId, "User interrupted the turn."),
    ]);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith("User interrupted the turn.");
    registry.unregister(turnId);
    expect(registry.hasActiveOwner(turnId)).toBe(false);

    let finishClaim!: (value: { status: "claimed" }) => void;
    const claiming = claimExecutionWithStartupInterrupt(registry, turnId,
      () => new Promise<{ status: "claimed" }>((resolve) => { finishClaim = resolve; }));
    expect(registry.hasActiveOwner(turnId)).toBe(true);
    expect(await registry.request(turnId, "Stop while claim is pending")).toBe(true);
    finishClaim({ status: "claimed" });
    await claiming;
    expect(registry.register(turnId, interrupt)).toBe("Stop while claim is pending");
    registry.unregister(turnId);
    await claimExecutionWithStartupInterrupt(registry, turnId, async () => ({ status: "already_claimed" }));
    expect(registry.hasActiveOwner(turnId)).toBe(false);
  });
});
