import type { ChatInterfaceEntry } from "./chatEntries";

export function conversationDateMarkers(
  entries: readonly ChatInterfaceEntry[],
): ReadonlySet<string> {
  const markers = new Set<string>();
  let previousActivity: number | null = null;
  for (const entry of entries) {
    const at =
      entry.kind === "message"
        ? entry.message.createdAt
        : entry.projection.startedAt;
    const time = at ? new Date(at).getTime() : NaN;
    const isBoundary =
      entry.kind === "message"
        ? entry.message.role === "user"
        : Boolean(entry.projection.continuationOfTurnId);
    if (
      isBoundary &&
      Number.isFinite(time) &&
      previousActivity !== null &&
      new Date(time).toDateString() !==
        new Date(previousActivity).toDateString() &&
      time > previousActivity
    ) {
      markers.add(entry.kind === "message" ? entry.message.id : entry.key);
    }
    const settled =
      entry.kind === "workflow" && entry.projection.settledAt
        ? Date.parse(entry.projection.settledAt)
        : NaN;
    for (const value of [time, settled]) {
      if (Number.isFinite(value))
        previousActivity = Math.max(previousActivity ?? value, value);
    }
  }
  return markers;
}
