import type { ToolboxEvent } from "./ToolboxEventFactory";

export interface ToolboxEventPublisher {
  publish(event: ToolboxEvent): void;
}

export class ConsoleToolboxEventPublisher implements ToolboxEventPublisher {
  publish(event: ToolboxEvent): void {
    if (event.status !== "completed" && event.status !== "failed") {
      return;
    }
    const level = event.status === "failed" ? console.warn : console.log;
    level(
      `[toolbox/tool] runId=${formatLogValue(event.runId)} toolName=${formatLogValue(event.toolName)} callId=${formatLogValue(event.callId)} status=${event.status}`,
    );
  }
}

function formatLogValue(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
