import { describe, expect, it } from "vitest";
import { RunEngine } from "./RunEngine.js";
import type { ILLMGateway } from "../llm/types.js";
import type { RuntimeDurableObjectState, RuntimeStorage } from "../types.js";

describe("RunEngine runId isolation", () => {
  it("keeps concurrent runs isolated by runId", async () => {
    const state = new MockRuntimeState();
    const runAId = "run_isolation_a";
    const runBId = "run_isolation_b";
    const sharedSessionId = "session-shared";
    const engineA = createEngine(state, runAId, sharedSessionId);
    const engineB = createEngine(state, runBId, sharedSessionId);

    await Promise.all([
      engineA.execute(
        { agentType: "coding", prompt: "hey", sessionId: sharedSessionId },
        [{ role: "user", content: "hey" }],
        {},
      ),
      engineB.execute(
        { agentType: "coding", prompt: "hey", sessionId: sharedSessionId },
        [{ role: "user", content: "hey" }],
        {},
      ),
    ]);

    const runA = await engineA.getRun(runAId);
    const runB = await engineB.getRun(runBId);

    expect(runA?.id).toBe(runAId);
    expect(runB?.id).toBe(runBId);
    expect(runA?.sessionId).toBe(sharedSessionId);
    expect(runB?.sessionId).toBe(sharedSessionId);
    expect(runA?.metadata.manifest).toBeDefined();
    expect(runB?.metadata.manifest).toBeDefined();
  });

  it("keeps three different-model runs on independent execution roots", async () => {
    const state = new MockRuntimeState();
    const scenarios = [
      { runId: "run_mixed_a", providerId: "openai", modelId: "gpt-5.6-luna" },
      { runId: "run_mixed_b", providerId: "google", modelId: "gemma-4-31b" },
      { runId: "run_mixed_c", providerId: "opencode", modelId: "big-pickle" },
    ];
    const engines = scenarios.map(({ runId }) =>
      createEngine(state, runId, `session-${runId}`),
    );

    await Promise.all(
      engines.map((engine, index) => {
        const scenario = scenarios[index]!;
        return engine.execute(
          {
            agentType: "coding",
            prompt: "inspect independently",
            sessionId: `session-${scenario.runId}`,
            providerId: scenario.providerId,
            modelId: scenario.modelId,
          },
          [{ role: "user", content: "inspect independently" }],
          {},
        );
      }),
    );

    const runs = await Promise.all(
      engines.map((engine, index) => engine.getRun(scenarios[index]!.runId)),
    );
    expect(runs.map((run) => run?.id)).toEqual(
      scenarios.map(({ runId }) => runId),
    );
    expect(
      new Set(scenarios.map(({ runId }) => `/home/sandbox/checkouts/${runId}`))
        .size,
    ).toBe(3);
  });
});

function createEngine(
  state: RuntimeDurableObjectState,
  runId: string,
  sessionId: string,
): RunEngine {
  return new RunEngine(
    state,
    {
      env: { NODE_ENV: "test" } as unknown,
      sessionId,
      runId,
      workspaceRoot: `/home/sandbox/checkouts/${runId}`,
      artifactRoot: `/home/sandbox/checkouts/${runId}/artifacts`,
      correlationId: `corr-${runId}`,
    },
    undefined,
    undefined,
    { llmGateway: createMockLLMGateway() },
  );
}

function createMockLLMGateway(): ILLMGateway {
  return {
    generateText: async () => ({
      text: "ok",
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }),
    generateStructured: async () => ({
      object: { tasks: [], metadata: { estimatedSteps: 1 } },
      usage: {
        provider: "mock",
        model: "mock-model",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    }),
    generateStream: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
  };
}

class InMemoryStorage implements RuntimeStorage {
  private store = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) {
        if (this.store.delete(entry)) {
          deleted += 1;
        }
      }
      return deleted;
    }
    return this.store.delete(key);
  }

  async list<T>(options?: {
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
  }): Promise<Map<string, T>> {
    const output = new Map<string, T>();
    const prefix = options?.prefix;
    const start = options?.start;
    const end = options?.end;
    const limit = options?.limit;

    for (const [key, value] of this.store.entries()) {
      if (prefix && !key.startsWith(prefix)) {
        continue;
      }
      if (start && key < start) {
        continue;
      }
      if (end && key >= end) {
        continue;
      }

      output.set(key, value as T);
      if (typeof limit === "number" && output.size >= limit) {
        break;
      }
    }

    return output;
  }
}

class MockRuntimeState implements RuntimeDurableObjectState {
  storage: RuntimeStorage = new InMemoryStorage();

  async blockConcurrencyWhile<T>(closure: () => Promise<T>): Promise<T> {
    return await closure();
  }
}
