import type { AppServerClient, LifecycleProjection } from "@legioncode/sdk";
import type {
  LocalWorkspaceGrant,
  ThreadId,
  TurnId,
  TurnDiffPayload,
  WorkspaceId,
} from "@repo/platform-protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

type ReviewClient = Pick<AppServerClient, "getTurnDiff">;

export interface DesktopSavedReviewScope {
  readonly client: ReviewClient;
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly grantedAt: LocalWorkspaceGrant["grantedAt"];
  readonly readiness: LocalWorkspaceGrant["readiness"];
}

export interface DesktopSavedReviewTurn {
  readonly workspaceId: WorkspaceId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly terminalState: NonNullable<LifecycleProjection["terminal"]>["state"];
}

export type DesktopSavedReviewRead =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; diff: TurnDiffPayload | null };

type SelectedReview = {
  readonly scope: DesktopSavedReviewScope;
  readonly turn: DesktopSavedReviewTurn;
};

function matchesScope(
  a: DesktopSavedReviewScope | null,
  b: DesktopSavedReviewScope | null,
): boolean {
  return Boolean(
    a &&
    b &&
    a.readiness === "ready" &&
    b.readiness === "ready" &&
    a.client === b.client &&
    a.workspaceId === b.workspaceId &&
    a.threadId === b.threadId &&
    a.grantedAt === b.grantedAt,
  );
}

/** User selection only; terminal identity must come from the actual SDK replay. */
export function useDesktopSavedReviewSelection(
  scope: DesktopSavedReviewScope | null,
  available = true,
) {
  const [selected, setSelected] = useState<SelectedReview | null>(null);
  const current =
    selected && matchesScope(selected.scope, scope) ? selected : null;
  const active = useRef({ scope, selected: current });

  useLayoutEffect(() => {
    const next = { scope, selected: current };
    active.current = next;
    if (selected && !current) setSelected(null);
    return () => {
      if (active.current === next)
        active.current = { scope: null, selected: null };
    };
  }, [scope, selected, current]);

  const select = useCallback(
    (turn: DesktopSavedReviewTurn): void => {
      if (
        !scope ||
        !matchesScope(scope, active.current.scope) ||
        turn.workspaceId !== scope.workspaceId ||
        turn.threadId !== scope.threadId
      )
        return;
      active.current = { scope: active.current.scope, selected: null };
      setSelected({ scope: { ...scope }, turn: { ...turn } });
    },
    [scope],
  );

  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{
    selected: SelectedReview;
    result: DesktopSavedReviewRead;
  } | null>(null);
  useEffect(() => {
    if (!current || !available) return;
    let active = true;
    setRead({ selected: current, result: { status: "loading" } });
    void current.scope.client.getTurnDiff({ turnId: current.turn.turnId })
      .then(({ diff }) => {
        if (!active) return;
        if (diff && diff.turnId !== current.turn.turnId)
          throw new Error("Saved diff belongs to another turn.");
        setRead({ selected: current, result: { status: "ready", diff } });
      })
      .catch(() => {
        if (active) setRead({ selected: current, result: { status: "error" } });
      });
    return () => { active = false; };
  }, [current, available, revision]);

  const result: DesktopSavedReviewRead = !current || !available
    ? { status: "idle" }
    : read?.selected === current
      ? read.result
      : { status: "loading" };
  return {
    selection: current?.turn ?? null,
    select,
    read: result,
    retry: () => setRevision((value) => value + 1),
  };
}
