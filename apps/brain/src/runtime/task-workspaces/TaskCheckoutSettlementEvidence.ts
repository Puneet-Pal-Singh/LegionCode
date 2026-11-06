import {
  LifecycleEventSchema,
  TurnDiffPayloadSchema,
  TurnWorkspaceSnapshotSchema,
  type LifecycleEvent,
  type RunAttemptId,
  type TurnId,
} from "@repo/platform-protocol";

/** Read only committed canonical evidence. External foreground terminal/Stop ACK
 * cannot authorize checkout release; the kernel captures immutable review only
 * after its execution strategy has established quiescence. */
export function hasImmutableRuntimeSettlement(
  input: readonly LifecycleEvent[],
  identity: { readonly turnId: TurnId; readonly runAttemptId: RunAttemptId },
): boolean {
  const parsed = input.map((event) => LifecycleEventSchema.safeParse(event));
  if (parsed.some((event) => !event.success)) return false;
  const events = parsed.flatMap((event) => (event.success ? [event.data] : []));
  if (
    events.some(
      (event) =>
        event.turnId !== identity.turnId ||
        event.runAttemptId !== identity.runAttemptId,
    )
  )
    return false;
  if (events.some((event, index) => event.sequence !== index + 1)) return false;
  if (
    events.filter((event) =>
      ["turn.completed", "turn.failed", "turn.interrupted"].includes(
        event.type,
      ),
    ).length !== 1
  )
    return false;
  const terminal = events.find((event) =>
    ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type),
  );
  if (
    !terminal ||
    events.some((event) => event.type === "workspace.snapshot_unavailable")
  )
    return false;
  const beforeTerminal = events.filter(
    (event) => event.sequence < terminal.sequence,
  );
  const snapshot = beforeTerminal.some((event) => {
    if (event.type !== "workspace.snapshot_captured") return false;
    const wrapper = event.payload.snapshot;
    if (
      !wrapper ||
      typeof wrapper !== "object" ||
      Array.isArray(wrapper) ||
      !("snapshot" in wrapper) ||
      !("artifact" in wrapper)
    )
      return false;
    const result = TurnWorkspaceSnapshotSchema.safeParse(wrapper.snapshot);
    return (
      result.success &&
      result.data.turnId === identity.turnId &&
      result.data.phase === "terminal"
    );
  });
  const diff = beforeTerminal.some((event) => {
    if (event.type !== "turn.diff_updated") return false;
    const result = TurnDiffPayloadSchema.safeParse(event.payload.diff);
    return result.success && result.data.turnId === identity.turnId;
  });
  return (
    snapshot &&
    diff &&
    beforeTerminal.some((event) => event.type === "artifact.created")
  );
}
