/**
 * ExecutionRuntimePort - Boundary for execution and orchestration dependencies.
 *
 * This port abstracts the communication between the Brain control plane and the
 * Muscle data plane (Secure Agent API). It owns task execution, orchestration,
 * and the execution lifecycle.
 *
 * Canonical alignment: ExecutionSandboxPort + RunOrchestratorPort (Charter 46)
 *
 * RunOrchestratorPort is now imported from @legioncode/orchestrator-core (Plan 64 CFA1).
 */

import type { RunOrchestratorPort } from "@legioncode/orchestrator-core";

export type { RunOrchestratorPort } from "@legioncode/orchestrator-core";

export interface TaskInput {
  taskId: string;
  action: string;
  params: Record<string, unknown>;
  timeout?: number;
  retryable?: boolean;
}

export interface TaskResult {
  taskId: string;
  status: "success" | "failure" | "timeout" | "cancelled";
  output?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  metrics?: {
    duration: number;
    memoryUsed?: number;
  };
}

/**
 * Port for executing tasks in a sandbox environment.
 * Abstracts Cloudflare sandbox primitives and future alternative executors.
 */
export interface ExecutionSandboxPort {
  executeTask(runId: string, input: TaskInput): Promise<TaskResult>;
  cancelTask(runId: string, taskId: string): Promise<boolean>;
}

/**
 * Composite port for complete execution runtime.
 * Combines sandbox execution and orchestration concerns.
 */
export interface ExecutionRuntimePort
  extends ExecutionSandboxPort,
    RunOrchestratorPort<TaskInput> {}
