// src/interfaces/types.ts
import { Sandbox } from "@cloudflare/sandbox";
import type { WorkspaceScope } from "../ports/SandboxExecutionLease";

// Definition for the callback function
export type LogCallback = (
  log:
    | string
    | {
        message: string;
        source?: "stdout" | "stderr";
      },
) => void;

export interface PluginResult {
  success: boolean;
  output?: string | Record<string, unknown> | null;
  error?: string;
  logs?: string[];
  isBinary?: boolean;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
}

/**
 * Server-issued execution identity. Plugins use this scope for all filesystem
 * authority; tool payloads retain a run id only for audit correlation.
 */
export interface PluginExecutionContext {
  workspaceScope: WorkspaceScope;
}

// OpenAI Tool Definition Schema
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// The Contract: Every feature (Redis, Python, Git) must follow this
export interface IPlugin {
  // The unique name (e.g., "python", "redis", "fs")
  name: string;

  // New: Plugins must describe their capabilities
  tools: ToolDefinition[];

  // Logic to run when the sandbox first boots (optional)
  // e.g., "Compile Go binary" or "pip install pandas"
  setup?(sandbox: Sandbox): Promise<void>;

  // The actual action
  execute(
    sandbox: Sandbox,
    payload: unknown,
    onLog?: LogCallback,
    context?: PluginExecutionContext,
  ): Promise<PluginResult>;
}

export interface Message {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}
