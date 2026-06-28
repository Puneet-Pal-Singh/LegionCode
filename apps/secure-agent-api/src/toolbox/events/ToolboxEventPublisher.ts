import type { ToolboxEvent } from "./ToolboxEventFactory";

export interface ToolboxEventPublisher {
  publish(event: ToolboxEvent): void;
}

export class ConsoleToolboxEventPublisher implements ToolboxEventPublisher {
  publish(event: ToolboxEvent): void {
    console.log(
      `[toolbox/event] sessionId=${formatLogValue(event.sessionId)} runId=${formatLogValue(event.runId)} toolName=${formatLogValue(event.toolName)} callId=${formatLogValue(event.callId)} status=${event.status} timestamp=${event.timestamp}`,
    );
  }
}

function formatLogValue(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
