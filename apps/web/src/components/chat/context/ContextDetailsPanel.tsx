import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-client-sdk";
import { formatCost, formatTokenCount } from "./context-format";

interface ContextDetailsPanelProps {
  budget: ContextBudgetSnapshot;
  usage: UsageCostSnapshot | null;
  session: ContextSessionSnapshot;
}

export interface ContextSessionSnapshot {
  title: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  createdAt: string;
  updatedAt: string;
}

export function ContextDetailsPanel({
  budget,
  usage,
  session,
}: ContextDetailsPanelProps) {
  const breakdown = buildContextBreakdown(budget);

  return (
    <div className="h-full overflow-y-auto px-6 py-7 text-sm text-zinc-300">
      <dl className="grid grid-cols-2 gap-x-8 gap-y-5">
        <Metric label="Session" value={session.title} />
        <Metric
          label="Messages"
          value={formatTokenCount(session.messageCount)}
        />
        <Metric label="Provider" value={budget.providerId} />
        <Metric label="Model" value={budget.modelId} />
        <Metric
          label="Context limit"
          value={formatTokenCount(budget.contextWindowLimit)}
        />
        <Metric
          label="Total tokens"
          value={formatTokenCount(budget.tokensUsed)}
        />
        <Metric
          label="Usage"
          value={`${Math.round(budget.utilizationPercent)}%`}
        />
        <Metric
          label="Tokens remaining"
          value={formatTokenCount(budget.tokensRemaining)}
        />
        <Metric
          label="Input tokens"
          value={formatOptional(usage?.inputTokens)}
        />
        <Metric
          label="Output tokens"
          value={formatOptional(usage?.outputTokens)}
        />
        {usage?.reasoningTokens != null ? (
          <Metric
            label="Reasoning tokens"
            value={formatTokenCount(usage.reasoningTokens)}
          />
        ) : null}
        {usage?.cachedInputTokens != null ? (
          <Metric
            label="Cache tokens (read/write)"
            value={`${formatTokenCount(usage.cachedInputTokens)} / —`}
          />
        ) : null}
        <Metric
          label="User messages"
          value={formatTokenCount(session.userMessageCount)}
        />
        <Metric
          label="Assistant messages"
          value={formatTokenCount(session.assistantMessageCount)}
        />
        <Metric
          label="Thread tokens"
          value={formatOptional(usage?.cumulativeThreadTokens)}
        />
        <Metric
          label="Total cost"
          value={formatOptionalCost(
            usage?.cumulativeThreadCost,
            usage?.currency,
          )}
        />
        <Metric
          label="Session created"
          value={formatTimestamp(session.createdAt)}
        />
        <Metric
          label="Last activity"
          value={formatTimestamp(session.updatedAt)}
        />
      </dl>

      <section className="mt-8 border-t border-zinc-800 pt-6">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-medium text-zinc-100">Context breakdown</h3>
          <span className="text-zinc-400">
            {formatTokenCount(budget.tokensUsed)} /{" "}
            {formatTokenCount(budget.effectiveInputBudget)}
          </span>
        </div>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-zinc-800">
          {breakdown.map((segment) => (
            <div
              key={segment.label}
              className={segment.color}
              style={{ width: `${segment.percent}%` }}
              title={`${segment.label}: ${formatTokenCount(segment.tokens)}`}
            />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-zinc-400">
          {breakdown.map((segment) => (
            <span key={segment.label} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${segment.color}`} />
              {segment.label} {Math.round(segment.percent)}%
            </span>
          ))}
        </div>
      </section>

      <p className="mt-8 border-t border-zinc-800 pt-5 text-zinc-500">
        Warning at {Math.round(budget.warningThresholdPercent)}%. Automatic
        compaction starts at{" "}
        {Math.round(budget.automaticCompactionThresholdPercent)}%.
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function formatOptional(value: number | null | undefined): string {
  return value == null ? "Unavailable" : formatTokenCount(value);
}

function formatOptionalCost(
  value: number | null | undefined,
  currency: string | undefined,
): string {
  return value == null ? "Unavailable" : formatCost(value, currency);
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

interface ContextBreakdownSegment {
  label: string;
  tokens: number;
  percent: number;
  color: string;
}

function buildContextBreakdown(
  budget: ContextBudgetSnapshot,
): ContextBreakdownSegment[] {
  const known = [
    ["System", budget.systemTokens, "bg-cyan-400"],
    ["Conversation", budget.conversationTokens, "bg-orange-300"],
    ["Tools", budget.toolDefinitionTokens, "bg-violet-400"],
    ["Attachments", budget.attachmentTokens, "bg-emerald-400"],
    ["Repository", budget.repositoryContextTokens, "bg-blue-400"],
  ] as const;
  const knownTotal = known.reduce(
    (total, [, tokens]) => total + (tokens ?? 0),
    0,
  );
  const withOther = [
    ...known,
    [
      "Other",
      Math.max(0, budget.tokensUsed - knownTotal),
      "bg-zinc-500",
    ] as const,
  ];
  const denominator = Math.max(1, budget.tokensUsed);

  return withOther.flatMap(([label, tokens, color]) => {
    if (tokens === null || tokens <= 0) {
      return [];
    }
    return [
      {
        label,
        tokens,
        percent: (tokens / denominator) * 100,
        color,
      },
    ];
  });
}
