export type ToolboxSessionStatus =
  | "requested"
  | "started"
  | "completed"
  | "failed"
  | "timeout";

export interface ToolboxSessionRequest {
  runId: string;
  toolName: string;
  callId: string;
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  borrowedLease?: boolean;
}

export interface ToolboxSessionHandle {
  sessionId: string;
  runId: string;
  toolName: string;
  callId: string;
  status: ToolboxSessionStatus;
  startedAt: number;
}

export interface ToolboxExecutionResult {
  sessionId: string;
  runId: string;
  toolName: string;
  callId: string;
  status: "completed" | "failed" | "timeout";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ToolboxPolicyDecision {
  decision: "allow" | "deny";
  reason?: string;
}

export interface ToolboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ToolboxCommandExecutionOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  borrowedLease?: boolean;
}

export interface ToolboxCommandExecutor {
  execute(
    command: string,
    options?: ToolboxCommandExecutionOptions,
  ): Promise<ToolboxCommandResult>;
}
