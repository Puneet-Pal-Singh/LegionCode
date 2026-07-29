import type {
  ContextBudgetSnapshot,
  UsageCostSnapshot,
} from "@repo/platform-protocol";

interface ContextDetailsPanelProps {
  budget: ContextBudgetSnapshot;
  usage: UsageCostSnapshot | null;
}

export function ContextDetailsPanel({
  budget,
  usage,
}: ContextDetailsPanelProps) {
  return (
    <div className="h-full overflow-y-auto px-6 py-7 text-sm text-zinc-300">
      <h2 className="text-lg font-semibold text-zinc-100">Context</h2>
      <p className="mt-1 text-xs text-zinc-500">
        Runtime-reported context and usage for the current thread.
      </p>

      <dl className="mt-7 grid grid-cols-2 gap-x-8 gap-y-6">
        <Metric label="Provider" value={budget.providerId} />
        <Metric label="Model" value={budget.modelId} />
        <Metric
          label="Context limit"
          value={formatNumber(budget.contextWindowLimit)}
        />
        <Metric
          label="Context used"
          value={`${Math.round(budget.utilizationPercent)}%`}
        />
        <Metric
          label="Tokens in context"
          value={formatNumber(budget.tokensUsed)}
        />
        <Metric
          label="Tokens remaining"
          value={formatNumber(budget.tokensRemaining)}
        />
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
          label="Thread tokens"
          value={formatOptional(usage?.cumulativeThreadTokens)}
        />
        <Metric
          label="Thread cost"
          value={
            usage?.cumulativeThreadCost == null
              ? "Unavailable"
              : `${usage.currency} ${usage.cumulativeThreadCost.toFixed(2)}`
          }
        />
      </dl>

      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="text-zinc-500">Context window</span>
          <span className="text-zinc-300">
            {formatNumber(budget.tokensUsed)} /{" "}
            {formatNumber(budget.contextWindowLimit)}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-cyan-400"
            style={{ width: `${Math.min(100, budget.utilizationPercent)}%` }}
          />
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          Measured by {budget.measurementSource}. Automatic compaction starts at{" "}
          {Math.round(budget.automaticCompactionThresholdPercent)}%.
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function formatOptional(value: number | null | undefined): string {
  return value == null ? "Unavailable" : formatNumber(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
