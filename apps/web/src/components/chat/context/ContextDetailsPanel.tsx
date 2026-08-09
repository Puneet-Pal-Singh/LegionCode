import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-client-sdk";
import { formatCost, formatTokenCount } from "./context-format";

interface ContextDetailsPanelProps {
  budget: ContextBudgetSnapshot;
  usage: UsageCostSnapshot | null;
}

export function ContextDetailsPanel({
  budget,
  usage,
}: ContextDetailsPanelProps) {
  const breakdown = buildContextBreakdown(budget);

  return (
    <div className="h-full overflow-y-auto px-6 py-7 text-sm text-zinc-300">
      <h2 className="font-semibold text-zinc-100">Context</h2>
      <p className="mt-1 text-zinc-500">
        Canonical runtime context and provider usage for the current thread.
      </p>

      <MetricSection title="Model">
        <Metric label="Provider" value={budget.providerId} />
        <Metric label="Model" value={budget.modelId} />
        <Metric
          label="Context limit"
          value={formatTokenCount(budget.contextWindowLimit)}
        />
        <Metric
          label="Effective input budget"
          value={formatTokenCount(budget.effectiveInputBudget)}
        />
        <Metric
          label="Context used"
          value={`${Math.round(budget.utilizationPercent)}%`}
        />
        <Metric
          label="Tokens remaining"
          value={formatTokenCount(budget.tokensRemaining)}
        />
      </MetricSection>

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

      <MetricSection title="Context composition">
        <Metric
          label="System instructions"
          value={formatOptional(budget.systemTokens)}
        />
        <Metric
          label="Conversation"
          value={formatOptional(budget.conversationTokens)}
        />
        <Metric
          label="Tool definitions"
          value={formatOptional(budget.toolDefinitionTokens)}
        />
        <Metric
          label="Attachments"
          value={formatOptional(budget.attachmentTokens)}
        />
        <Metric
          label="Repository context"
          value={formatOptional(budget.repositoryContextTokens)}
        />
        <Metric
          label="Output reserve"
          value={formatTokenCount(budget.reservedOutputTokens)}
        />
        <Metric
          label="Safety reserve"
          value={formatTokenCount(budget.safetyReserveTokens)}
        />
        <Metric label="Measured by" value={budget.measurementSource} />
      </MetricSection>

      <MetricSection title="Latest turn usage">
        <Metric
          label="Input tokens"
          value={formatOptional(usage?.inputTokens)}
        />
        <Metric
          label="Output tokens"
          value={formatOptional(usage?.outputTokens)}
        />
        <Metric
          label="Reasoning tokens"
          value={formatOptional(usage?.reasoningTokens)}
        />
        <Metric
          label="Cached input"
          value={formatOptional(usage?.cachedInputTokens)}
        />
        <Metric
          label="Total tokens"
          value={formatOptional(usage?.totalTokens)}
        />
        <Metric
          label="Turn cost"
          value={formatOptionalCost(usage?.currentTurnCost, usage?.currency)}
        />
        <Metric
          label="Thread tokens"
          value={formatOptional(usage?.cumulativeThreadTokens)}
        />
        <Metric
          label="Thread cost"
          value={formatOptionalCost(
            usage?.cumulativeThreadCost,
            usage?.currency,
          )}
        />
      </MetricSection>

      <p className="mt-8 border-t border-zinc-800 pt-5 text-zinc-500">
        Warning at {Math.round(budget.warningThresholdPercent)}%. Automatic
        compaction starts at{" "}
        {Math.round(budget.automaticCompactionThresholdPercent)}%.
      </p>
    </div>
  );
}

function MetricSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 border-t border-zinc-800 pt-6">
      <h3 className="font-medium text-zinc-100">{title}</h3>
      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-5">{children}</dl>
    </section>
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
    ["Other", Math.max(0, budget.tokensUsed - knownTotal), "bg-zinc-500"] as const,
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
