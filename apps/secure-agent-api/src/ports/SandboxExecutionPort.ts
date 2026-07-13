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

export interface TaskExecutionError {
  code: string;
  message: string;
  details?: unknown;
}

export interface TaskExecutionResult {
  taskId: string;
  leaseId: string;
  correlationId: string;
  status: "success" | "failure" | "timeout" | "cancelled" | "sandbox_unavailable";
  retryable: boolean;
  output?: string;
  error?: TaskExecutionError;
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

export interface LeaseReleaseResult {
  released: boolean;
  sandboxReleased: boolean;
}

export interface SandboxExecutionPort {
  acquireLease(
    request: SandboxExecutionLeaseRequest,
  ): Promise<SandboxExecutionLease>;
  registerLease(lease: SandboxExecutionLease): void;
  executeTask(
    leaseId: string,
    input: TaskExecutionInput,
    hooks?: TaskExecutionHooks,
  ): Promise<TaskExecutionResult>;
  cancelTask(leaseId: string, taskId: string): Promise<boolean>;
  getHealth(leaseId: string): Promise<{
    healthy: boolean;
    memoryUsed?: number;
    cpuUsage?: number;
  }>;
  cleanup(leaseId: string): Promise<void>;
  releaseLease(leaseId: string): Promise<LeaseReleaseResult>;
}
