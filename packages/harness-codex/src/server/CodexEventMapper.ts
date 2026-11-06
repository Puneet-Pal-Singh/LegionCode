import { createHash } from "node:crypto";
import { z } from "zod";
import { ItemIdSchema, ToolCallIdSchema } from "@repo/platform-protocol";
import type { HarnessObservationPayload } from "@repo/worker-protocol";
import { codexTurnUsage } from "./CodexUsageReader.js";

export const nativeIdentity = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});
export function codexItemId(attemptId: string, nativeId: string) {
  return ItemIdSchema.parse(`itm_${digest(attemptId, nativeId)}`);
}
export function codexToolId(attemptId: string, nativeId: string) {
  return ToolCallIdSchema.parse(`toolcall_${digest(attemptId, nativeId)}`);
}
function digest(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Maps only proven canonical variants. Raw native payloads never escape as product events. */
export function codexEventPayload(
  method: string,
  raw: unknown,
  attempt: string,
  model: string,
): HarnessObservationPayload | null {
  if (method === "thread/tokenUsage/updated") {
    const value = nativeIdentity.extend({ tokenUsage: z.unknown() }).parse(raw);
    return { kind: "usage", usage: codexTurnUsage(value.tokenUsage, model) };
  }
  if (method !== "item/started" && method !== "item/completed") return null;
  const { item } = nativeIdentity
    .extend({
      item: z.object({ id: z.string().min(1), type: z.string() }).passthrough(),
    })
    .parse(raw);
  const itemId = codexItemId(attempt, item.id);
  if (item.type === "agentMessage" && method === "item/completed") {
    return {
      kind: "assistant_text",
      itemId,
      text: z.string().max(1_048_576).parse(item.text),
    };
  }
  if (!["commandExecution", "fileChange", "mcpToolCall"].includes(item.type))
    return null;
  if (method === "item/started") {
    // Command details belong to provider-owned tool evidence, not a native tool execution request.
    return {
      kind: "tool_started",
      itemId,
      content: {
        toolCallId: codexToolId(attempt, item.id),
        toolName: `codex.${item.type}`,
        input: {
          source: "harness_reported",
          command:
            item.type === "commandExecution"
              ? z.string().max(65536).parse(item.command)
              : null,
          cwd:
            item.type === "commandExecution"
              ? z.string().max(4096).parse(item.cwd)
              : null,
        },
      },
    };
  }
  if (item.status !== "completed")
    throw new Error(
      "Codex non-success tool outcome requires canonical failure variant",
    );
  return {
    kind: "tool_completed",
    itemId,
    output:
      typeof item.aggregatedOutput === "string"
        ? z.string().max(1_048_576).parse(item.aggregatedOutput)
        : item.type === "mcpToolCall"
          ? z
              .string()
              .max(1_048_576)
              .parse(JSON.stringify(item.result ?? null))
          : "",
  };
}
