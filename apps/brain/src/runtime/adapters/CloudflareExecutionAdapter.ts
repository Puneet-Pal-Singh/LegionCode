/**
 * CloudflareExecutionAdapter - Cloudflare implementation of ExecutionRuntimePort.
 *
 * Bridges Cloudflare Durable Objects and Workers to execution port contracts.
 * This adapter owns the lifecycle of runs and task scheduling on Cloudflare infra.
 */

import type { DurableObjectState as LegacyDurableObjectState } from "@cloudflare/workers-types";
import type { ExecutionRuntimePort, TaskInput, TaskResult } from "../ports";
import type {
  RunStateEnvelope,
  RunStatus,
  ScheduledTaskEnvelope,
} from "@legioncode/orchestrator-core";

/**
 * Cloudflare-backed implementation of execution and orchestration.
 *
 * Owns:
 * - Run state transitions via Durable Objects
 * - Task scheduling and sequencing
 * - Task result persistence
 */
export class CloudflareExecutionAdapter implements ExecutionRuntimePort {
  private readonly ctx: unknown;

  constructor(ctx: unknown) {
    this.ctx = ctx;
  }

  async executeTask(_runId: string, _input: TaskInput): Promise<TaskResult> {
    // This method will be called by the Secure Agent API (Muscle).
    // The adapter here merely ensures type conformance.
    // Actual execution is handled by secure-agent-api's ExecutionSandboxPort implementation.
    throw new Error(
      "ExecutionSandboxPort.executeTask should be invoked at Muscle boundary, not Brain.",
    );
  }

  async cancelTask(_runId: string, _taskId: string): Promise<boolean> {
    // Implementation stub: Actual cancellation is handled at Muscle boundary
    throw new Error(
      "ExecutionRuntimePort.cancelTask should be invoked at Muscle boundary, not Brain.",
    );
  }

  async getRunState(_runId: string): Promise<RunStateEnvelope | null> {
    // Implementation stub: Actual state management is handled at Muscle boundary
    throw new Error(
      "ExecutionRuntimePort.getRunState should be invoked at Muscle boundary, not Brain.",
    );
  }

  async transitionRun(_runId: string, _newStatus: RunStatus): Promise<void> {
    // Implementation stub: Actual transitions are handled at Muscle boundary
    throw new Error(
      "ExecutionRuntimePort.transitionRun should be invoked at Muscle boundary, not Brain.",
    );
  }

  async scheduleNext(_runId: string): Promise<ScheduledTaskEnvelope<TaskInput> | null> {
    // Implementation stub: Actual scheduling is handled at Muscle boundary
    throw new Error(
      "ExecutionRuntimePort.scheduleNext should be invoked at Muscle boundary, not Brain.",
    );
  }
}
