/**
 * EventFormatter - Pure string serialization for runtime events
 *
 * Single responsibility: Convert RuntimeEvent to string representation
 * No truncation, no decisions, pure serialization
 */
import type { RuntimeEvent } from "@legioncode/context-assembly";

export interface EventFormatOptions {
  includeTimestamp?: boolean;
  includeEventId?: boolean;
}

export function formatEvent(
  event: RuntimeEvent,
  options: EventFormatOptions = {},
): string {
  const { includeTimestamp = true, includeEventId = false } = options;
  const parts: string[] = [];

  parts.push(`[${event.type}]`);

  if (includeTimestamp) {
    parts.push(`Time: ${new Date(event.timestamp).toISOString()}`);
  }

  if (includeEventId && event.eventId) {
    parts.push(`EventID: ${event.eventId}`);
  }

  switch (event.type) {
    case "tool_call":
      parts.push(`Tool: ${event.payload.toolName}`);
      parts.push(`CallID: ${event.payload.toolCallId}`);
      parts.push(`Args: ${JSON.stringify(event.payload.args)}`);
      break;

    case "tool_error":
      parts.push(`Tool: ${event.payload.toolName}`);
      parts.push(`CallID: ${event.payload.toolCallId}`);
      parts.push(`Error: ${event.payload.error}`);
      parts.push(`Retryable: ${event.payload.retryable}`);
      break;

    case "tool_result":
      parts.push(`Tool: ${event.payload.toolName}`);
      parts.push(`CallID: ${event.payload.toolCallId}`);
      parts.push(`Duration: ${event.payload.durationMs}ms`);
      parts.push(`Result: ${JSON.stringify(event.payload.result)}`);
      break;

    case "execution_result":
      parts.push(`Success: ${event.payload.success}`);
      if (event.payload.output) {
        parts.push(`Output: ${event.payload.output}`);
      }
      if (event.payload.error) {
        parts.push(`Error: ${event.payload.error}`);
      }
      if (event.payload.exitCode !== undefined) {
        parts.push(`ExitCode: ${event.payload.exitCode}`);
      }
      break;

    case "user_interruption":
    case "agent_switch":
    case "checkpoint":
      parts.push(`Payload: ${JSON.stringify(event.payload)}`);
      break;

    default: {
      // Exhaustive check enforced at compile time via never type
      const _exhaustiveCheck: never = event;
      parts.push(`Unknown event type: ${_exhaustiveCheck}`);
    }
  }

  return parts.join("\n");
}

export function formatEvents(
  events: RuntimeEvent[],
  options?: EventFormatOptions,
): string {
  if (events.length === 0) {
    return "";
  }

  return events.map((event) => formatEvent(event, options)).join("\n\n");
}
