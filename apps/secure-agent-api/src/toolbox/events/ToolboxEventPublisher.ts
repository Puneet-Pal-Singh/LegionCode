import type { ToolboxEvent } from "./ToolboxEventFactory";

export interface ToolboxEventPublisher {
  publish(event: ToolboxEvent): void;
}

export class ConsoleToolboxEventPublisher implements ToolboxEventPublisher {
  publish(event: ToolboxEvent): void {
    if (event.status !== "completed" && event.status !== "failed") {
      return;
    }
    if (event.status === "completed" && !shouldLogSuccessfulToolboxEvents()) {
      return;
    }
    const level = event.status === "failed" ? console.warn : console.log;
    level(
      `[toolbox/event] sessionId=${formatLogValue(event.sessionId)} runId=${formatLogValue(event.runId)} toolName=${formatLogValue(event.toolName)} callId=${formatLogValue(event.callId)} status=${event.status} timestamp=${event.timestamp}`,
    );
  }
}

function shouldLogSuccessfulToolboxEvents(): boolean {
  return readEnvironmentFlag("LEGIONCODE_VERBOSE_TOOLBOX_LOGS");
}

function readEnvironmentFlag(name: string): boolean {
  const env = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return env.process?.env?.[name] === "true";
}

function formatLogValue(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
