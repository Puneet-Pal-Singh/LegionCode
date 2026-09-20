import type { AppServerEnvironmentSnapshot } from "@repo/platform-protocol";

const STATUS_LABELS: Record<AppServerEnvironmentSnapshot["status"], string> = {
  starting: "Starting environment",
  ready: "Environment ready",
  degraded: "Environment degraded",
  offline: "Environment offline",
  stopped: "Environment stopped",
};

export function EnvironmentStatus({
  snapshot,
  onRetry,
}: {
  snapshot: AppServerEnvironmentSnapshot;
  onRetry?: () => void;
}): React.JSX.Element {
  const unavailableCount = snapshot.unavailableCapabilities.length;
  return (
    <aside
      className={`lc-environment-status lc-environment-status-${snapshot.status}`}
      aria-label="Environment status"
      data-environment-kind={snapshot.kind}
      data-environment-status={snapshot.status}
    >
      <span className="lc-environment-status-dot" aria-hidden="true" />
      <span>{STATUS_LABELS[snapshot.status]}</span>
      {snapshot.reason ? <small>{snapshot.reason}</small> : null}
      {unavailableCount > 0 ? (
        <small>{unavailableCount} capability slices unavailable</small>
      ) : null}
      {onRetry && (snapshot.status === "offline" || snapshot.status === "degraded") ? (
        <button type="button" onClick={onRetry}>
          Restart
        </button>
      ) : null}
    </aside>
  );
}
