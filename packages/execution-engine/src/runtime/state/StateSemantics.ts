export type RuntimeStateSemantics = "do" | "kv" | "unknown";

interface SemanticsTaggedState {
  __legioncodeStateSemantics?: RuntimeStateSemantics;
}

export function getRuntimeStateSemantics(
  state: object,
): RuntimeStateSemantics {
  const taggedState = state as SemanticsTaggedState;
  return taggedState.__legioncodeStateSemantics ?? "unknown";
}

export function assertRuntimeStateSemantics(
  state: object,
  options: { requireStrictDoSemantics: boolean; runtimePath: string },
): void {
  if (!options.requireStrictDoSemantics) {
    return;
  }

  const semantics = getRuntimeStateSemantics(state);
  if (semantics !== "do") {
    throw new Error(
      `[state/semantics] ${options.runtimePath} requires durable-object semantics but received "${semantics}"`,
    );
  }
}

export function tagRuntimeStateSemantics<T extends object>(
  state: T,
  semantics: "do" | "kv",
): T {
  const taggedState = state as T & SemanticsTaggedState;
  taggedState.__legioncodeStateSemantics = semantics;
  return taggedState;
}
