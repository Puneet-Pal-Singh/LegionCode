import type { AppServerClient, LifecycleProjection } from "@legioncode/sdk";
import type {
  LocalWorkspaceGrant,
  ThreadId,
  TurnId,
  WorkspaceId,
} from "@repo/platform-protocol";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

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

  const client = useMemo<ReviewClient>(() => {
    const captured = current;
    const assertCurrent = (turnId: TurnId): SelectedReview => {
      if (
        !captured ||
        active.current.selected !== captured ||
        !matchesScope(captured.scope, active.current.scope) ||
        captured.turn.turnId !== turnId
      ) {
        throw new DOMException("Saved review scope changed.", "AbortError");
      }
      return captured;
    };
    return {
      getTurnDiff: async (params) => {
        const selectedScope = assertCurrent(params.turnId);
        const result = await selectedScope.scope.client.getTurnDiff(params);
        assertCurrent(params.turnId);
        return result;
      },
    };
  }, [current]);

  return { selection: current?.turn ?? null, select, client };
}
