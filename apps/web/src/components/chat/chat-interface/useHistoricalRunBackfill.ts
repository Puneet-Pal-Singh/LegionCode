import { useRunActivityFeed } from "../../../hooks/useRunActivityFeed.js";
import { useRunEvents } from "../../../hooks/useRunEvents.js";
import { useRunSummary } from "../../../hooks/useRunSummary.js";

interface HistoricalRunBackfill {
  readonly summary: ReturnType<typeof useRunSummary>["summary"];
  readonly events: ReturnType<typeof useRunEvents>["events"];
  readonly feed: ReturnType<typeof useRunActivityFeed>["feed"];
}

/**
 * Historical projections are useful for older sessions, but never own an
 * active lifecycle-backed turn. Keep this boundary explicit at the call site.
 */
export function useHistoricalRunBackfill(input: {
  runId: string;
  enabled: boolean;
}): HistoricalRunBackfill {
  const { runId, enabled } = input;
  const { summary } = useRunSummary(runId, enabled);
  const { events } = useRunEvents(runId, enabled, 0);
  const { feed } = useRunActivityFeed(runId, enabled);
  return { summary, events, feed };
}
