import type {
  HookOutcomeByEventName,
  PrivateAlphaHookEventName,
} from "@repo/hook-protocol";
import type {
  HookExecutionCleanupInput,
  HookExecutionInput,
  HookExecutorPort,
} from "./HookRuntimePorts";

export const TRUSTED_SESSION_OBSERVER_KEY =
  "internal:session-observer-v1";
export const TRUSTED_PROMPT_OBSERVER_KEY =
  "internal:prompt-observer-v1";

export interface TrustedDeclarativeHookHandler {
  readonly configurationKey: string;
  readonly eventName: PrivateAlphaHookEventName;
  execute(
    request: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  cleanup?(input: HookExecutionCleanupInput): Promise<void>;
}

/**
 * Exact-key in-process dispatch only. Configuration keys are never interpreted
 * as commands, URLs, paths, modules, or plugin names.
 */
export class TrustedDeclarativeHookExecutor implements HookExecutorPort {
  private readonly handlers: ReadonlyMap<
    string,
    TrustedDeclarativeHookHandler
  >;

  constructor(handlers: readonly TrustedDeclarativeHookHandler[]) {
    const entries = handlers.map(
      (handler) => [handler.configurationKey, handler] as const,
    );
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error("Trusted hook configuration keys must be unique.");
    }
    this.handlers = new Map(entries);
  }

  async execute<EventName extends PrivateAlphaHookEventName>(
    input: HookExecutionInput<EventName>,
  ): Promise<unknown> {
    const handler = this.resolve(input.definition.configurationKey);
    if (handler.eventName !== input.definition.eventName) {
      throw new Error("Trusted hook event does not match its definition.");
    }
    return await handler.execute(input.request, input.signal);
  }

  async cleanup(input: HookExecutionCleanupInput): Promise<void> {
    const key = input.definition.configurationKey;
    if (key === null) return;
    const handler = this.handlers.get(key);
    if (handler?.cleanup) {
      await handler.cleanup(input);
    }
  }

  private resolve(
    configurationKey: string | null,
  ): TrustedDeclarativeHookHandler {
    const handler =
      configurationKey === null
        ? undefined
        : this.handlers.get(configurationKey);
    if (!handler) {
      throw new Error("Hook handler is not registered by the server.");
    }
    return handler;
  }
}

export function createProductionTrustedHookExecutor(): TrustedDeclarativeHookExecutor {
  return new TrustedDeclarativeHookExecutor([
    createObserverHandler(
      TRUSTED_SESSION_OBSERVER_KEY,
      "SessionStart",
      {
        status: "continue",
        userVisibleMessage: null,
        modelContextAdditions: [],
        auditMetadata: {},
      },
    ),
    createObserverHandler(
      TRUSTED_PROMPT_OBSERVER_KEY,
      "UserPromptSubmit",
      {
        status: "continue",
        normalizedPrompt: null,
        userVisibleMessage: null,
        modelContextAdditions: [],
        auditMetadata: {},
      },
    ),
  ]);
}

function createObserverHandler<
  EventName extends "SessionStart" | "UserPromptSubmit",
>(
  configurationKey: string,
  eventName: EventName,
  outcome: HookOutcomeByEventName[EventName],
): TrustedDeclarativeHookHandler {
  return {
    configurationKey,
    eventName,
    async execute(_request, signal): Promise<unknown> {
      if (signal.aborted) {
        throw new Error("Hook execution was cancelled.");
      }
      return outcome;
    },
  };
}
