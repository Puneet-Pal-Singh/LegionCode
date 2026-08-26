import { describe, expect, it, vi } from "vitest";
import { interruptAndAwaitTerminal } from "./useChatCore";

describe("interruptAndAwaitTerminal", () => {
  it("stops the chat transport as soon as runtime accepts the interrupt", async () => {
    let releaseTerminal: (() => void) | undefined;
    const terminalReady = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const stopTransport = vi.fn();
    const lifecycleClient = {
      interruptTurn: vi.fn(async () => ({
        runId: "run_123e4567e89b42d3a456426614174000",
        accepted: true,
        status: "interrupt_requested",
      })),
      followTurnLifecycle: vi.fn(async function* () {
        await terminalReady;
        yield { type: "turn.interrupted" };
      }),
    };

    const settlement = interruptAndAwaitTerminal(
      lifecycleClient as never,
      {
        runId: "run_123e4567e89b42d3a456426614174000",
        workspaceId: "wsp_test01",
        sessionId: "d1137b54-39df-4f38-b012-478018630ace",
        threadId: "thr_test01",
        turnId: "trn_test01",
        runAttemptId: "attempt_test01",
      },
      stopTransport,
    );

    await vi.waitFor(() => expect(stopTransport).toHaveBeenCalledOnce());
    releaseTerminal?.();
    await settlement;
  });
});
