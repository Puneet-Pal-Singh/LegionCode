import { describe, expect, it } from "vitest";
import { ToolCallIdSchema } from "@repo/platform-protocol";
import type {
  ApprovalWaitPort,
  ContextAssemblyPort,
  ProviderPort,
  WorkerProtocolPort,
} from "./ports.js";
import { approvalRequest, manifest, run, turn } from "./test-fixtures.js";

describe("runtime kernel port contracts", () => {
  it("keeps worker execution run-scoped and manifest-backed", async () => {
    const worker: WorkerProtocolPort = {
      executeTool: async (input) => {
        expect(input.runId).toBe(run.id);
        expect(input.turnId).toBe(turn.id);
        expect(input.workspace).toEqual(manifest);
        return { kind: "completed", output: { ok: true } };
      },
    };

    await expect(
      worker.executeTool({
        runId: run.id,
        turnId: turn.id,
        workspace: manifest,
        toolCall: {
          toolCallId: ToolCallIdSchema.parse("toolcall_runtime001"),
          toolName: "write_file",
          input: { path: "src/index.ts" },
        },
        approval: null,
      }),
    ).resolves.toMatchObject({ kind: "completed" });
  });

  it("supports independently implemented context, provider, and approval ports", async () => {
    const context: ContextAssemblyPort = {
      assemble: async () => ({ instructions: "test", metadata: {} }),
    };
    const provider: ProviderPort = {
      generateNext: async () => ({ kind: "complete", output: "done" }),
    };
    const approvals: ApprovalWaitPort = {
      waitForDecision: async () => ({
        decision: "approved",
        decidedBy: run.userId,
        reason: null,
      }),
    };

    await expect(
      context.assemble({ run, turn, workspace: manifest }),
    ).resolves.toMatchObject({ instructions: "test" });
    await expect(
      provider.generateNext({
        run,
        turn,
        workspace: manifest,
        context: { instructions: "test", metadata: {} },
        toolResults: [],
      }),
    ).resolves.toMatchObject({ kind: "complete" });
    await expect(
      approvals.waitForDecision({
        runId: run.id,
        turnId: turn.id,
        request: approvalRequest,
      }),
    ).resolves.toMatchObject({ decision: "approved" });
  });
});
