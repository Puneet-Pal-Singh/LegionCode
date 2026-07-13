import { describe, expect, it, vi } from "vitest";
import { TurnIdSchema } from "@repo/platform-protocol";
import { InMemoryRunInterruptRegistry } from "./RunInterruptRegistry";

describe("InMemoryRunInterruptRegistry", () => {
  it("coalesces repeated in-flight interrupt requests for one turn", async () => {
    const registry = new InMemoryRunInterruptRegistry();
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const turnId = TurnIdSchema.parse("trn_123456");
    registry.register(turnId, interrupt);

    await Promise.all([
      registry.request(turnId, "User interrupted the turn."),
      registry.request(turnId, "User interrupted the turn."),
    ]);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledWith("User interrupted the turn.");
  });
});
