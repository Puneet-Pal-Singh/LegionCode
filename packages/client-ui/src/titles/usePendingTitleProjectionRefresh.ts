import { useEffect, useMemo, useRef } from "react";

const POLL_INTERVAL_MS = 750;
// Keep the existing 20-second title budget's projection visible through settlement.
const TITLE_GENERATION_SETTLEMENT_WINDOW_MS = 24_000;
const MAX_POLLS = Math.ceil(TITLE_GENERATION_SETTLEMENT_WINDOW_MS / POLL_INTERVAL_MS);

export interface PendingTitleProjection {
  id: string;
  titleVersion?: number;
  titleStatus?: "pending" | "ready" | "failed";
}
export interface PendingTitleProjectionRefreshInput<TProjection> {
  enabled: boolean;
  scopeKey?: string;
  records: readonly PendingTitleProjection[];
  readProjection: () => Promise<TProjection>;
  getRecords: (projection: TProjection) => readonly PendingTitleProjection[];
  onProjection: (projection: TProjection) => void;
  onError?: (error: unknown) => void;
}

/** Bounded reads of server-owned pending metadata; never schedules title generation. */
export function usePendingTitleProjectionRefresh<TProjection>({
  enabled, scopeKey = "", records, readProjection, getRecords, onProjection, onError,
}: PendingTitleProjectionRefreshInput<TProjection>): void {
  const pollCounts = useRef(new Map<string, number>());
  const latest = useRef({ enabled, scopeKey, readProjection });
  latest.current = { enabled, scopeKey, readProjection };
  const pendingKey = useMemo(() => JSON.stringify(records
    .filter((record) => record.titleStatus === "pending")
    .map((record) => [record.id, record.titleVersion ?? 0] as const)
    .sort(([left], [right]) => left.localeCompare(right))), [records]);

  useEffect(() => {
    const pending: Array<readonly [string, number]> = JSON.parse(pendingKey);
    if (!enabled || pending.length === 0) return;
    let cancelled = false;
    let timeout: number | undefined;
    const current = () => !cancelled && latest.current.enabled &&
      latest.current.scopeKey === scopeKey && latest.current.readProjection === readProjection;
    const countKey = (id: string, version: number) => JSON.stringify([scopeKey, id, version]);
    const schedule = () => {
      timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    const poll = async () => {
      const eligible = pending.filter(([id, version]) =>
        (pollCounts.current.get(countKey(id, version)) ?? 0) < MAX_POLLS);
      if (!current() || eligible.length === 0) return;
      for (const [id, version] of eligible) {
        const key = countKey(id, version);
        pollCounts.current.set(key, (pollCounts.current.get(key) ?? 0) + 1);
      }
      try {
        const projection = await readProjection();
        if (!current()) return;
        onProjection(projection);
        const next = new Map(getRecords(projection).map((record) => [record.id, record]));
        if (eligible.some(([id, version]) => {
          const record = next.get(id);
          return !record || (record.titleStatus === "pending" && (record.titleVersion ?? 0) === version);
        })) schedule();
      } catch (error) {
        if (!current()) return;
        onError?.(error);
        schedule();
      }
    };
    schedule();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [enabled, scopeKey, pendingKey, readProjection, getRecords, onProjection, onError]);
}
