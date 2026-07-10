import type {
  SandboxExecutionLease,
  SandboxExecutionLeaseRequest,
} from "./SandboxExecutionLease";

export interface TaskExecutionInput {
  taskId: string;
  action: string;
  params: Record<string, unknown>;
  lease: SandboxExecutionLease;
  timeout?: number;
  retryable?: boolean;
}

export interface TaskExecutionResult {
  taskId: string;
  leaseId: string;
  correlationId: string;
  status: "success" | "failure" | "timeout" | "cancelled";
  retryable: boolean;
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

export interface TaskExecutionHooks {
  onLog?: (entry: {
    message: string;
    source?: "stdout" | "stderr";
  }) => Promise<void> | void;
}

export interface SandboxExecutionPort {
  acquireLease(
    request: SandboxExecutionLeaseRequest,
  ): Promise<SandboxExecutionLease>;
  executeTask(
    sessionId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult>;
  cancelTask(sessionId: string, taskId: string): Promise<boolean>;
  getHealth(sessionId: string): Promise<{
    healthy: boolean;
    memoryUsed?: number;
    cpuUsage?: number;
  }>;
  cleanup(sessionId: string): Promise<void>;
  releaseLease(leaseId: string): Promise<boolean>;
}
