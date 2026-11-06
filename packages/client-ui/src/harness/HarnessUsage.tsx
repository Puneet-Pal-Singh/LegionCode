import {
  projectHarnessUsage,
  projectHarnessAttemptElapsedMs,
  type HarnessUsageScope,
  type LifecycleEvent,
} from "@legioncode/sdk";

export interface HarnessUsageProps {
  scope: HarnessUsageScope;
  events: readonly LifecycleEvent[];
  onManageUsage?: () => void;
}

/** Presentation only: reads canonical replay/continuation, never polls a provider. */
export function HarnessUsage({
  scope,
  events,
  onManageUsage,
}: HarnessUsageProps): React.JSX.Element {
  const sample = projectHarnessUsage(scope, events);
  const usage = sample?.payload.usage;
  const elapsedMs = projectHarnessAttemptElapsedMs(scope, events);
  return (
    <section aria-label="Harness usage" className="lc-harness-usage">
      <h3>Account quota</h3>
      <p>Unavailable. Account-wide allowance is separate from token usage.</p>
      {onManageUsage ? (
        <button type="button" onClick={onManageUsage}>
          Manage usage
        </button>
      ) : null}
      <h3>
        {!usage
          ? "Token usage"
          : usage.measurementSource === "estimate"
            ? "Estimated token sample"
            : "Provider-reported token sample"}
      </h3>
      {usage && sample ? (
        <>
          <dl>
            <Metric label="Input tokens" value={usage.inputTokens} />
            <Metric label="Output tokens" value={usage.outputTokens} />
            <Metric
              label="Cached input tokens"
              value={usage.cachedInputTokens}
            />
            <Metric label="Reasoning tokens" value={usage.reasoningTokens} />
            <Metric label="Total tokens in sample" value={usage.totalTokens} />
          </dl>
          <p>
            Provider: {usage.providerId} · Model: {usage.modelId}
          </p>
          <p>Attempt: {sample.runAttemptId}</p>
          <p>
            Reported at{" "}
            <time dateTime={sample.createdAt}>{sample.createdAt}</time>
          </p>
          <p>
            Latest sample for this attempt. Child usage coverage and attempt
            totals are unavailable.
          </p>
        </>
      ) : (
        <p>No token usage reported for this attempt.</p>
      )}
      <h3>Attempt elapsed time</h3>
      <p>
        {elapsedMs === null
          ? "Unavailable until start and settlement are recorded."
          : `${(elapsedMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} seconds`}
      </p>
      <p>Recorded start-to-settlement time, including waits.</p>
      <h3>LegionCode compute and storage charges</h3>
      <p>Unavailable.</p>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value === null ? "Unavailable" : value.toLocaleString()}</dd>
    </div>
  );
}
