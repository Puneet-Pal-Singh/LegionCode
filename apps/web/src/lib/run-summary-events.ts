export const RUN_SUMMARY_REFRESH_EVENT = "shadowbox:run-summary-refresh";

interface RunSummaryRefreshDetail {
  runId: string;
  source?: "chat" | "run-event-stream" | "manual";
}

export function dispatchRunSummaryRefresh(
  runId: string,
  options: { source?: RunSummaryRefreshDetail["source"] } = {},
): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<RunSummaryRefreshDetail>(RUN_SUMMARY_REFRESH_EVENT, {
      detail: { runId, source: options.source ?? "manual" },
    }),
  );
}
