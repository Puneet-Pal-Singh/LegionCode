/**
 * SystemAssembler - Dumb transformation for system prompt
 *
 * Single responsibility: Generate system prompt string
 * No decisions, no truncation, pure string assembly
 */
import type {
  AgentDescriptor,
  ToolDescriptor,
} from "@legioncode/context-assembly";

export interface SystemAssemblyInput {
  agent: AgentDescriptor;
  tools: ToolDescriptor[];
  goal?: string;
}

export function assembleSystem(input: SystemAssemblyInput): string {
  const lines: string[] = [];

  lines.push(`# System Instructions`);
  lines.push("");
  lines.push(
    `You are an AI assistant with the following role: ${input.agent.role}`,
  );
  lines.push("");

  if (input.agent.capabilities.length > 0) {
    lines.push("## Capabilities");
    for (const capability of input.agent.capabilities) {
      lines.push(`- ${capability}`);
    }
    lines.push("");
  }

  if (input.goal) {
    lines.push("## Current Goal");
    lines.push(input.goal);
    lines.push("");
  }

  if (input.tools.length > 0) {
    lines.push("## Available Tools");
    for (const tool of input.tools) {
      lines.push(`- ${tool.name}: ${tool.description}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
