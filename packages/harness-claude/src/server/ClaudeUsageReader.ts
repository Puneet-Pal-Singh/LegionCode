import { createHash } from "node:crypto";
import {
  HarnessActivityMeasurementSchema,
  ProviderIdSchema,
  ModelIdSchema,
  HarnessProviderLimitNotificationSchema,
} from "@repo/platform-protocol";
import type {
  HarnessSelection,
  HarnessActivityMeasurement,
  HarnessProviderLimitNotification,
} from "@repo/platform-protocol";
import type { HarnessSession } from "@repo/worker-protocol";
import type {
  SDKRateLimitEvent,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

type Context = {
  readonly selection: HarnessSelection;
  readonly session: HarnessSession;
  readonly observedAt: string;
  readonly sequence: () => number;
  readonly previous: ReadonlyMap<string, HarnessActivityMeasurement>;
};

function identity(
  context: Context,
  nativeId: string,
  component: string,
): string {
  return `claude_usage_${createHash("sha256")
    .update(JSON.stringify([context.session, nativeId, component]))
    .digest("hex")}`;
}
function count(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
function amount(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function sum(values: readonly (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return count(total);
}

function resetAt(seconds: number | undefined): string | null {
  if (
    seconds === undefined ||
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds * 1000 > 8.64e15
  )
    return null;
  return new Date(seconds * 1000).toISOString();
}

/** SDK modelUsage already includes children/sidechains and is cumulative. Never
 * add main-loop usage or the aggregate total_cost_usd to these per-model records.
 */
export function readClaudeRunUsage(
  message: SDKResultMessage,
  context: Context,
): HarnessActivityMeasurement[] {
  if (Object.keys(message.modelUsage).length > 256)
    throw new Error("Claude usage model limit exceeded");
  return Object.entries(message.modelUsage)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([modelId, usage]) => {
      if (usage.provider !== undefined && usage.provider !== "firstParty")
        throw new Error("Claude usage provider differs from the frozen route");
      const inputTokens = sum([
        count(usage.inputTokens),
        count(usage.cacheReadInputTokens),
        count(usage.cacheCreationInputTokens),
      ]);
      const outputTokens = count(usage.outputTokens);
      const reasoning = count(usage.thinkingTokens);
      const measurement = HarnessActivityMeasurementSchema.parse({
        measurementId: identity(context, message.uuid, modelId),
        sequence: context.sequence(),
        providerId: ProviderIdSchema.parse("anthropic"),
        modelId: ModelIdSchema.parse(modelId),
        threadId: context.selection.threadId,
        turnId: context.selection.turnId,
        runAttemptId: context.selection.runAttemptId,
        instanceId: context.session.instanceId,
        externalSessionId: context.session.externalSessionId,
        parentExternalSessionId: null,
        processGeneration: context.session.processGeneration,
        source: "claude_agent_sdk.result.modelUsage",
        observedAt: context.observedAt,
        aggregation: "cumulative",
        scope: "session",
        childCoverage: "includes_children",
        measurementSource: "provider",
        uncachedInputTokens: count(usage.inputTokens),
        cacheReadInputTokens: count(usage.cacheReadInputTokens),
        cacheCreationInputTokens: count(usage.cacheCreationInputTokens),
        inputTokens,
        outputTokens,
        cachedInputTokens: sum([
          count(usage.cacheReadInputTokens),
          count(usage.cacheCreationInputTokens),
        ]),
        reasoningTokens:
          reasoning !== null &&
          outputTokens !== null &&
          reasoning > outputTokens
            ? null
            : reasoning,
        // Reasoning is a subset of output; caches are input categories, not extra outputs.
        totalTokens: sum([inputTokens, outputTokens]),
        estimatedCostUsd: amount(usage.costUSD),
      } satisfies HarnessActivityMeasurement);
      const previous = context.previous.get(modelId);
      const counters = [
        "inputTokens",
        "uncachedInputTokens",
        "cacheReadInputTokens",
        "cacheCreationInputTokens",
        "outputTokens",
        "cachedInputTokens",
        "totalTokens",
        "estimatedCostUsd",
      ] as const;
      // SDK startup/crash results can be zeroed. A lower cumulative snapshot is
      // not a refund or evidence that already measured work disappeared.
      const unreliable = counters.some(
        (key) =>
          measurement[key] !== null &&
          previous?.[key] !== null &&
          previous?.[key] !== undefined &&
          measurement[key] < previous[key],
      );
      if (unreliable) {
        for (const key of counters) measurement[key] = null;
        measurement.reasoningTokens = null;
      }
      return measurement;
    });
}

/** Supported passive SDK notices only. API/org/service notices never become account quota. */
export function readClaudeRateLimit(
  message: SDKRateLimitEvent,
  context: Context,
): HarnessProviderLimitNotification[] {
  const info = message.rate_limit_info;
  const common = {
    threadId: context.selection.threadId,
    turnId: context.selection.turnId,
    runAttemptId: context.selection.runAttemptId,
    instanceId: context.session.instanceId,
    externalSessionId: context.session.externalSessionId,
    processGeneration: context.session.processGeneration,
    modelId: null,
    observedAt: context.observedAt,
    // SDK service/channel/group-pool scopes are not account-wide subscription scope.
    // Retain the reported scope in the opaque display kind without upgrading it.
    scope: "unknown" as const,
  };
  const status = (
    value: typeof info.status,
  ): HarnessProviderLimitNotification["status"] =>
    value === "allowed"
      ? "allowed"
      : value === "allowed_warning"
        ? "warning"
        : value === "rejected"
          ? "limited"
          : "unknown";
  const kind = (...parts: (string | undefined)[]) =>
    parts.filter((part) => part !== undefined).join(":") || null;
  const providerLimit = HarnessProviderLimitNotificationSchema.parse({
    ...common,
    notificationId: identity(context, message.uuid, "limit"),
    sequence: context.sequence(),
    source: "claude_agent_sdk.rate_limit_event",
    status: status(info.status),
    limitKind: kind(info.limitScope, info.rateLimitType),
    resetsAt: resetAt(info.resetsAt),
  } satisfies HarnessProviderLimitNotification);
  const observations: HarnessProviderLimitNotification[] = [providerLimit];
  if (info.overageStatus !== undefined) {
    observations.push(
      HarnessProviderLimitNotificationSchema.parse({
        ...common,
        notificationId: identity(context, message.uuid, "overage"),
        sequence: context.sequence(),
        source: "claude_agent_sdk.rate_limit_event.overage",
        status: status(info.overageStatus),
        limitKind: kind(info.limitScope, "overage", info.overageDisabledReason),
        resetsAt: resetAt(info.overageResetsAt),
      } satisfies HarnessProviderLimitNotification),
    );
  }
  return observations;
}

/** Correlation/deduplication only. Host assigns observation sequences and persists the facts. */
export class ClaudeUsageReader {
  private sequence = 0;
  private readonly seen = new Map<string, string>();
  private readonly previous = new Map<string, HarnessActivityMeasurement>();
  constructor(
    private readonly session: HarnessSession,
    private readonly selection: HarnessSelection,
  ) {
    if (
      session.runAttemptId !== selection.runAttemptId ||
      session.instanceId !== selection.instanceId ||
      selection.harness !== "claude" ||
      selection.transport !== "claude_agent_sdk"
    ) {
      throw new Error("Claude usage binding differs from the admitted attempt");
    }
  }

  read(
    message: SDKResultMessage | SDKRateLimitEvent,
    observedAt = new Date().toISOString(),
  ): {
    readonly measurements: readonly HarnessActivityMeasurement[];
    readonly notifications: readonly HarnessProviderLimitNotification[];
  } {
    if (message.session_id !== this.session.externalSessionId)
      throw new Error("Claude usage session changed");
    const key = `${message.type}:${message.uuid}`;
    const fingerprint = JSON.stringify(
      message.type === "result" ? message.modelUsage : message.rate_limit_info,
    );
    const previous = this.seen.get(key);
    if (previous !== undefined) {
      if (previous !== fingerprint)
        throw new Error("Claude usage identity payload changed");
      return { measurements: [], notifications: [] };
    }
    if (this.seen.size >= 4096)
      throw new Error("Claude usage observation limit exceeded");
    const context: Context = {
      session: this.session,
      selection: this.selection,
      observedAt,
      sequence: () => ++this.sequence,
      previous: this.previous,
    };
    const measurements =
      message.type === "result" ? readClaudeRunUsage(message, context) : [];
    const notifications =
      message.type === "rate_limit_event"
        ? readClaudeRateLimit(message, context)
        : [];
    this.seen.set(key, fingerprint);
    for (const measurement of measurements) {
      if (
        measurement.totalTokens !== null &&
        measurement.estimatedCostUsd !== null
      )
        this.previous.set(measurement.modelId, measurement);
    }
    return { measurements, notifications };
  }
}
