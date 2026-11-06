import {
  projectHarnessUsage,
  projectHarnessAccountUsage,
  type HarnessUsageObservation,
  projectHarnessAttemptElapsedMs,
  type HarnessUsageScope,
  type LifecycleEvent,
} from "@legioncode/sdk";

export interface HarnessUsageProps {
  scope?: HarnessUsageScope;
  events?: readonly LifecycleEvent[];
  observation?: HarnessUsageObservation | null;
  onManageUsage?: () => void;
}

/** Presentation only: reads canonical replay/continuation, never polls a provider. */
export function HarnessUsage({
  scope,
  events = [],
  observation = null,
  onManageUsage,
}: HarnessUsageProps): React.JSX.Element {
  const account = observation ? projectHarnessAccountUsage(observation) : null;
  const activity =
    account?.activity.filter(
      (measurement) =>
        !scope ||
        (measurement.threadId === scope.threadId &&
          measurement.turnId === scope.turnId &&
          measurement.runAttemptId === scope.runAttemptId),
    ) ?? [];
  const sample = scope && !account ? projectHarnessUsage(scope, events) : null;
  const usage = sample?.payload.usage;
  const elapsedMs = scope
    ? projectHarnessAttemptElapsedMs(scope, events)
    : null;
  return (
    <section aria-label="Harness usage" className="lc-harness-usage">
      <h3>Account quota</h3>
      {account ? (
        <>
          <p>Billing route: {account.billingRoute}</p>
          <p>Account-wide quota: {account.quota.state}</p>
          <p>Source: {account.quota.source ?? "Unavailable"}</p>
          <p>
            Checked:{" "}
            {account.quota.checkedAt ? (
              <time dateTime={account.quota.checkedAt}>
                {account.quota.checkedAt}
              </time>
            ) : (
              "Unavailable"
            )}
          </p>
          {account.quota.windows?.map((window, index) => (
            <dl key={index}>
              <dt>{window.label ?? window.bucketId ?? "Quota window"}</dt>
              <dd>
                {window.utilizationPercent === null
                  ? "Utilization unavailable"
                  : `${window.utilizationPercent}% used`}
              </dd>
              <Metric label="Remaining" value={window.remaining} />
              <Metric label="Limit" value={window.limit} />
              <dt>Unit</dt>
              <dd>{window.unit ?? "Unavailable"}</dd>
              <dt>Resets</dt>
              <dd>{window.resetsAt ?? "Unavailable"}</dd>
            </dl>
          ))}
          {account.quota.windows?.length === 0 ? (
            <p>No numerical windows reported.</p>
          ) : null}
          <p>Account-wide allowance may include usage from other apps.</p>
        </>
      ) : (
        <p>Unavailable. No account observation received.</p>
      )}
      {onManageUsage ? (
        <button type="button" onClick={onManageUsage}>
          Manage usage
        </button>
      ) : null}
      {account ? (
        <>
          <h3>Measured activity</h3>
          {account.conflictingMeasurementCount > 0 ? (
            <p>
              {account.conflictingMeasurementCount} conflicting measurements
              excluded.
            </p>
          ) : null}
          {activity.length === 0 ? (
            <p>No activity measurements reported.</p>
          ) : null}
          {activity.slice(0, 50).map((measurement) => (
            <div
              key={JSON.stringify([
                measurement.runAttemptId,
                measurement.instanceId,
                measurement.externalSessionId,
                measurement.processGeneration,
                measurement.source,
                measurement.sequence,
                measurement.measurementId,
              ])}
            >
              <p>
                {measurement.measurementSource === "estimate"
                  ? "Estimated"
                  : "Provider-reported"}{" "}
                {measurement.scope} sample · {measurement.aggregation}
              </p>
              <p>
                Provider: {measurement.providerId} · Model:{" "}
                {measurement.modelId}
              </p>
              <p>
                Attempt: {measurement.runAttemptId} · Child coverage:{" "}
                {measurement.childCoverage}
              </p>
              <dl>
                <Metric label="Input tokens" value={measurement.inputTokens} />
                <Metric
                  label="Output tokens"
                  value={measurement.outputTokens}
                />
                <Metric
                  label="Cached input tokens"
                  value={measurement.cachedInputTokens}
                />
                <Metric
                  label="Reasoning tokens"
                  value={measurement.reasoningTokens}
                />
                <Metric
                  label="Total tokens in sample"
                  value={measurement.totalTokens}
                />
              </dl>
              <p>
                Source: {measurement.source} ·{" "}
                <time dateTime={measurement.observedAt}>
                  {measurement.observedAt}
                </time>
              </p>
            </div>
          ))}
          {activity.length > 50 ? <p>Showing up to 50 measurements.</p> : null}
          <p>Samples are not summed across requests, sessions or children.</p>
        </>
      ) : null}
      {!account ? (
        <>
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
                <Metric
                  label="Reasoning tokens"
                  value={usage.reasoningTokens}
                />
                <Metric
                  label="Total tokens in sample"
                  value={usage.totalTokens}
                />
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
        </>
      ) : null}
      {scope ? (
        <>
          <h3>Attempt elapsed time</h3>
          <p>
            {elapsedMs === null
              ? "Unavailable until start and settlement are recorded."
              : `${(elapsedMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} seconds`}
          </p>
          <p>Recorded start-to-settlement time, including waits.</p>
        </>
      ) : null}
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
