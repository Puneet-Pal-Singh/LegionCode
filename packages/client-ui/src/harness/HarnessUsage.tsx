import type { HarnessSelection } from "@repo/platform-protocol";
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
  /** Immutable runtime admission receipt, never the current picker selection. */
  admittedSelection?: HarnessSelection | null;
  events?: readonly LifecycleEvent[];
  observation?: HarnessUsageObservation | null;
  onManageUsage?: () => void;
}

/** Presentation only: reads canonical replay/continuation, never polls a provider. */
export function HarnessUsage({
  scope,
  admittedSelection = null,
  events = [],
  observation = null,
  onManageUsage,
}: HarnessUsageProps): React.JSX.Element {
  const projection = projectHarnessAccountUsage(
    observation,
    scope,
    scope ? events : [],
    scope ? admittedSelection : null,
  );
  const account = projection.account;
  const activity = projection.activity;
  const sample = scope ? projectHarnessUsage(scope, events) : null;
  const usage = sample?.payload.usage;
  const elapsedMs = scope
    ? projectHarnessAttemptElapsedMs(scope, events)
    : null;
  return (
    <section aria-label="Harness usage" className="lc-harness-usage">
      {!scope ? (
        <p>
          Account usage only. No attempt is selected; its frozen inference payer
          is unknown.
        </p>
      ) : null}
      <h3>Account quota</h3>
      {account ? (
        <>
          <p>Observed account billing route: {account.billingRoute}</p>
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
          {account.quota.state === "stale" ? (
            <p>Cached allowance; current remaining quota is unknown.</p>
          ) : account.quota.state === "unavailable" ||
            account.quota.state === "unsupported" ? (
            <p>
              Remaining quota is unknown. Run tokens do not establish an
              allowance.
            </p>
          ) : null}
          {account.quota.windows?.map((window, index) => (
            <dl key={index}>
              <dt>{window.label ?? "Quota window"}</dt>
              <dd>
                {window.utilizationPercent === null
                  ? "Utilization unavailable"
                  : `${window.utilizationPercent}% used`}
              </dd>
              <Metric
                label="Remaining at last check"
                value={window.remaining}
              />
              <Metric label="Limit" value={window.limit} />
              <dt>Unit</dt>
              <dd>{window.unit ?? "Unavailable"}</dd>
              <dt>Resets</dt>
              <dd>{window.resetsAt ?? "Unavailable"}</dd>
            </dl>
          ))}
          {account.quota.windows?.length === 0 ? (
            <p>No numerical windows reported. Remaining quota is unknown.</p>
          ) : null}
          <p>Account-wide allowance may include usage from other apps.</p>
          {projection.accountMatchesAttempt === false ? (
            <p>
              This account observation does not match the admitted attempt. Its
              activity is excluded.
            </p>
          ) : null}
        </>
      ) : (
        <p>Unavailable. No account observation received.</p>
      )}
      {onManageUsage ? (
        <button type="button" onClick={onManageUsage}>
          Manage usage
        </button>
      ) : null}
      {scope ? (
        <>
          <h3>Admitted inference billing</h3>
          {projection.admittedSelection ? (
            <p>
              Admitted inference billing route:{" "}
              {projection.admittedSelection.billingSource}
            </p>
          ) : (
            <p>
              Frozen attempt payer: Unknown. No admitted binding receipt is
              available.
            </p>
          )}
        </>
      ) : null}
      <>
        <h3>
          {scope
            ? "Run token and model cost samples"
            : "Reported model activity for this account"}
        </h3>
        {projection.conflictingMeasurementCount > 0 ? (
          <p>
            {projection.conflictingMeasurementCount} conflicting measurements
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
              Provider: {measurement.providerId} · Model: {measurement.modelId}
            </p>
            <p>
              Child usage coverage:{" "}
              {measurement.childCoverage === "self_only"
                ? "This session only"
                : measurement.childCoverage === "includes_children"
                  ? "Includes child sessions"
                  : "Unknown"}
            </p>
            <dl>
              <Metric label="Input tokens" value={measurement.inputTokens} />
              <Metric
                label="Uncached input tokens"
                value={measurement.uncachedInputTokens}
              />
              <Metric
                label="Cache read input tokens"
                value={measurement.cacheReadInputTokens}
              />
              <Metric
                label="Cache creation input tokens"
                value={measurement.cacheCreationInputTokens}
              />
              <Metric
                label="Estimated model cost (USD)"
                value={measurement.estimatedCostUsd}
                monetary
              />
              <Metric label="Output tokens" value={measurement.outputTokens} />
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
        <p>
          Samples are not summed across requests, sessions or children.
          Reasoning tokens are included in output. Monetary estimates are not
          subscription charges.
        </p>
        <h3>Provider limit notifications</h3>
        <p>
          Limit notifications do not establish remaining subscription allowance.
        </p>
        {projection.conflictingLimitNotificationCount > 0 ? (
          <p>
            {projection.conflictingLimitNotificationCount} conflicting limit
            notifications excluded.
          </p>
        ) : null}
        {projection.providerLimits.length === 0 ? (
          <p>No limit notifications reported.</p>
        ) : null}
        {projection.providerLimits.slice(0, 50).map((notification) => (
          <div
            key={JSON.stringify([
              notification.runAttemptId,
              notification.instanceId,
              notification.externalSessionId,
              notification.processGeneration,
              notification.sequence,
              notification.source,
              notification.notificationId,
            ])}
          >
            <p>
              {notification.status} · Scope: {notification.scope} ·{" "}
              {notification.limitKind ?? "Limit kind unavailable"}
            </p>
            <p>Resets: {notification.resetsAt ?? "Unavailable"}</p>
            <p>
              Source: {notification.source} ·{" "}
              <time dateTime={notification.observedAt}>
                {notification.observedAt}
              </time>
            </p>
          </div>
        ))}
        {projection.providerLimits.length > 50 ? (
          <p>Showing up to 50 limit notifications.</p>
        ) : null}
      </>
      {scope ? (
        <>
          <h3>
            {!usage
              ? "Canonical attempt token sample"
              : usage.measurementSource === "estimate"
                ? "Estimated token sample"
                : "Provider-reported token sample"}
          </h3>
          {usage && sample ? (
            <>
              <dl>
                <Metric label="Input tokens" value={usage.inputTokens} />
                <Metric
                  label={`Estimated turn model cost (${usage.currency})`}
                  value={usage.currentTurnCost}
                  monetary
                />
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
              <p>
                Reported at{" "}
                <time dateTime={sample.createdAt}>{sample.createdAt}</time>
              </p>
              <p>
                Latest sample for this attempt. Child usage coverage and attempt
                totals are unavailable. Model cost estimates are not
                subscription charges. This sample may overlap the detailed
                measurements above; do not add them.
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
      <h3>LegionCode compute, storage and payer</h3>
      <p>Compute usage and charges: Unavailable.</p>
      <p>Storage usage and charges: Unavailable.</p>
      <p>Compute and storage payer: Unavailable.</p>
      <p>
        Account billing route does not establish a frozen attempt payer. Model
        tokens and recorded elapsed time do not establish metered cloud compute
        or storage. Subscription inference does not imply free cloud compute.
      </p>
    </section>
  );
}

function Metric({
  label,
  value,
  monetary = false,
}: {
  label: string;
  value: number | null;
  monetary?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value === null
          ? "Unavailable"
          : value.toLocaleString(
              undefined,
              monetary ? { maximumSignificantDigits: 10 } : undefined,
            )}
      </dd>
    </div>
  );
}
