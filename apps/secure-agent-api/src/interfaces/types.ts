// src/interfaces/types.ts
import { Sandbox } from "@cloudflare/sandbox";

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
  ): Promise<PluginResult>;
}

export interface Message {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}
