/**
 * EventAssembler - Dumb transformation for runtime events
 *
 * Single responsibility: Transform runtime events to context message
 * No truncation, no decisions, pure transformation
 */
import type { RuntimeEvent, ContextMessage } from "@legioncode/context-assembly";
import { formatEvents } from "../formatters/EventFormatter.js";

export function assembleEvents(events: RuntimeEvent[]): ContextMessage {
  const content = formatEvents(events, {
    includeTimestamp: true,
    includeEventId: false,
  });

  return {
    role: "user",
    content: content || "No recent events.",
    metadata: {
      source: "events",
    },
  };
}
