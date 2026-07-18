import {
  HookDefinitionSchema,
  type HookDefinition,
  type HookSource,
  type PrivateAlphaHookEventName,
} from "@repo/hook-protocol";

/**
 * Immutable, validated hook configuration snapshot. Configuration owners
 * replace the registry when settings change; runtime callers cannot mutate it.
 */
export class HookRegistry {
  private readonly definitions: readonly HookDefinition[];

  constructor(definitions: readonly unknown[]) {
    const validated = definitions.map((definition) =>
      HookDefinitionSchema.parse(definition),
    );
    assertUniqueHandlerIds(validated);
    this.definitions = Object.freeze([...validated].sort(compareDefinitions));
  }

  list(): readonly HookDefinition[] {
    return this.definitions;
  }

  enabledFor(
    eventName: PrivateAlphaHookEventName,
  ): readonly HookDefinition[] {
    return this.definitions.filter(
      (definition) => definition.enabled && definition.eventName === eventName,
    );
  }
}

function assertUniqueHandlerIds(definitions: readonly HookDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.handlerId)) {
      throw new Error(
        `Duplicate hook handler registration: ${definition.handlerId}`,
      );
    }
    seen.add(definition.handlerId);
  }
}

function compareDefinitions(
  left: HookDefinition,
  right: HookDefinition,
): number {
  return (
    left.order - right.order ||
    sourceOrder(left.source) - sourceOrder(right.source) ||
    left.handlerId.localeCompare(right.handlerId)
  );
}

function sourceOrder(source: HookSource): number {
  switch (source) {
    case "project":
      return 0;
    case "plugin":
      return 1;
    case "user":
      return 2;
  }
}
