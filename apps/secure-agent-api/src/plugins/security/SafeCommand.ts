import { Sandbox } from "@cloudflare/sandbox";
import { CloudflareToolboxAdapter } from "../../toolbox/adapters/CloudflareToolboxAdapter";
import { ToolboxSessionService } from "../../toolbox/services/ToolboxSessionService";

export interface SafeCommandSpec {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  runId?: string;
  toolName?: string;
  callId?: string;
  timeoutMs?: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId?: string;
  callId?: string;
  toolName?: string;
  runId?: string;
  status?: "completed" | "failed" | "timeout";
  durationMs?: number;
}

export async function runSafeCommand(
  sandbox: Sandbox,
  spec: SafeCommandSpec,
  allowlist: readonly string[],
): Promise<CommandResult> {
  const service = new ToolboxSessionService(
    new CloudflareToolboxAdapter(sandbox),
  );
  const result = await service.execute(
    {
      runId: resolveToolboxRunId(spec),
      toolName: spec.toolName ?? spec.command,
      callId: spec.callId ?? createToolCallId(spec.command),
      command: spec.command,
      args: spec.args,
      env: spec.env,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
    },
    allowlist,
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    sessionId: result.sessionId,
    callId: result.callId,
    toolName: result.toolName,
    runId: result.runId,
    status: result.status,
    durationMs: result.durationMs,
  };
}

function createToolCallId(command: string): string {
  return `${command}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveToolboxRunId(spec: SafeCommandSpec): string {
  if (spec.runId) {
    return spec.runId;
  }

  const candidate = spec.cwd ?? findWorkspacePathInArgs(spec.args);
  if (!candidate) {
    return "default";
  }

  const match = candidate.match(/\/home\/sandbox\/runs\/([A-Za-z0-9_-]{1,128})/);
  return match?.[1] ?? "default";
}

function findWorkspacePathInArgs(args: string[] | undefined): string | null {
  if (!args) {
    return null;
  }

  const cwdIndex = args.findIndex((arg) => arg === "-C");
  if (cwdIndex >= 0) {
    return args[cwdIndex + 1] ?? null;
  }

  return args.find((arg) => arg.startsWith("/home/sandbox/checkouts/")) ?? null;
}
