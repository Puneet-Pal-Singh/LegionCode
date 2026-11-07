import type { ModelRef, SessionUsageUpdated } from "@opencode/client";
import {
  UsageCostSnapshotSchema,
  HarnessActivityMeasurementSchema,
  type HarnessActivityMeasurement,
  type HarnessSelection,
  type UsageCostSnapshot,
} from "@repo/platform-protocol";
import type { HarnessSession } from "@repo/worker-protocol";
import { OpenCodeTransportError } from "./OpenCodeClient.js";

/** Native session counters are cumulative per session, not account allowance. */
export class OpenCodeUsageReader {
  private readonly sessions = new Map<
    string,
    SessionUsageUpdated["data"]["tokens"]
  >();

  constructor(
    private readonly model: ModelRef,
    private readonly canonicalModelId: string,
    private readonly priorThreadTokens: number,
  ) {}

  observe(event: SessionUsageUpdated): UsageCostSnapshot {
    const current = components(event.data.tokens);
    const previous = this.sessions.get(event.data.sessionID);
    if (
      current.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      (previous &&
        current.some((value, index) => value < components(previous)[index]!))
    ) {
      throw new OpenCodeTransportError("non-cumulative usage counters", true);
    }
    if (
      !this.sessions.has(event.data.sessionID) &&
      this.sessions.size >= 1000
    ) {
      throw new OpenCodeTransportError("usage session bound", true);
    }
    // Replace snapshots. Adding each usage.updated notification would count the same step repeatedly.
    this.sessions.set(event.data.sessionID, structuredClone(event.data.tokens));
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let reasoningTokens = 0;
    for (const tokens of this.sessions.values()) {
      inputTokens += tokens.input + tokens.cache.read + tokens.cache.write;
      outputTokens += tokens.output + tokens.reasoning;
      cachedInputTokens += tokens.cache.read;
      reasoningTokens += tokens.reasoning;
    }
    try {
      return UsageCostSnapshotSchema.parse({
        providerId: this.model.providerID,
        modelId: this.canonicalModelId,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningTokens,
        totalTokens: inputTokens + outputTokens,
        cumulativeThreadTokens:
          this.priorThreadTokens + inputTokens + outputTokens,
        // Native cost can use catalog estimates. It is not evidence of the selected account's bill.
        currentTurnCost: null,
        cumulativeThreadCost: null,
        currency: "USD",
        measurementSource: "provider",
      });
    } catch {
      throw new OpenCodeTransportError("usage validation", true);
    }
  }

  /** Same measured counters as the transcript summary, with explicit binding and
   * child coverage for the existing account-usage projection. No account quota. */
  measurement(input: {
    readonly usage: UsageCostSnapshot;
    readonly selection: HarnessSelection;
    readonly session: HarnessSession;
    readonly measurementId: string;
    readonly sequence: number;
    readonly observedAt: string;
  }): HarnessActivityMeasurement {
    let uncached = 0;
    let read = 0;
    let write = 0;
    for (const tokens of this.sessions.values()) {
      uncached += tokens.input;
      read += tokens.cache.read;
      write += tokens.cache.write;
    }
    return HarnessActivityMeasurementSchema.parse({
      measurementId: input.measurementId,
      sequence: input.sequence,
      providerId: input.usage.providerId,
      modelId: input.usage.modelId,
      threadId: input.selection.threadId,
      turnId: input.selection.turnId,
      runAttemptId: input.session.runAttemptId,
      instanceId: input.session.instanceId,
      externalSessionId: input.session.externalSessionId,
      parentExternalSessionId: null,
      processGeneration: input.session.processGeneration,
      source: "opencode_v2.session.usage.updated",
      observedAt: input.observedAt,
      aggregation: "cumulative",
      scope: "attempt",
      // Pinned native session counters cover only that session. Sum distinct
      // root/descendant snapshots once, replacing repeated notifications.
      childCoverage: "includes_children",
      measurementSource: "provider",
      inputTokens: input.usage.inputTokens,
      uncachedInputTokens: uncached,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
      outputTokens: input.usage.outputTokens,
      cachedInputTokens: read + write,
      reasoningTokens: input.usage.reasoningTokens,
      totalTokens: input.usage.totalTokens,
      estimatedCostUsd: null,
    });
  }
}

function components(
  tokens: SessionUsageUpdated["data"]["tokens"],
): readonly number[] {
  return [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache.read,
    tokens.cache.write,
  ];
}
