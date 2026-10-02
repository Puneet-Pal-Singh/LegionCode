import type { DurableObjectState } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import {
  assertRuntimeStateSemantics,
  getRuntimeStateSemantics,
  tagRuntimeStateSemantics,
} from "@legioncode/execution-engine/runtime";

describe("StateSemantics", () => {
  it("defaults to unknown semantics when state is untagged", () => {
    const state = createMockDurableObjectState();
    expect(getRuntimeStateSemantics(state)).toBe("unknown");
  });

  it("allows strict mode when semantics are durable-object", () => {
    const state = tagRuntimeStateSemantics(createMockDurableObjectState(), "do");
    expect(() =>
      assertRuntimeStateSemantics(state, {
        requireStrictDoSemantics: true,
        runtimePath: "test-path",
      }),
    ).not.toThrow();
  });

  it("blocks strict mode when semantics are kv", () => {
    const state = tagRuntimeStateSemantics(createMockDurableObjectState(), "kv");
    expect(() =>
      assertRuntimeStateSemantics(state, {
        requireStrictDoSemantics: true,
        runtimePath: "test-path",
      }),
    ).toThrow(/requires durable-object semantics/);
  });
});

function createMockDurableObjectState(): DurableObjectState {
  return {
    storage: {
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => true,
      list: async () => new Map<string, unknown>(),
      transaction: async <T>(
        closure: (txn: DurableObjectState["storage"]) => Promise<T>,
      ) => closure({} as DurableObjectState["storage"]),
      blockConcurrencyWhile: async <T>(closure: () => Promise<T>) => closure(),
    } as unknown as DurableObjectState["storage"],
    id: { toString: () => "mock-do" } as DurableObjectState["id"],
    waitUntil: async (promise: Promise<unknown>): Promise<void> => {
      await promise;
    },
    blockConcurrencyWhile: async <T>(closure: () => Promise<T>): Promise<T> =>
      closure(),
  } as unknown as DurableObjectState;
}
