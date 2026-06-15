import { z } from "zod";
import { createInvalidTransitionError } from "./errors.js";

export const WorkspaceStateSchema = z.enum([
  "empty",
  "preparing",
  "cloning",
  "ready",
  "dirty",
  "committed",
  "pushed",
  "pr_opened",
  "failed",
  "closed",
]);
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export const WorkspaceCloseUnresolvedChangesPolicySchema = z.enum([
  "reject",
  "allow_close",
]);
export type WorkspaceCloseUnresolvedChangesPolicy = z.infer<
  typeof WorkspaceCloseUnresolvedChangesPolicySchema
>;

export type WorkspaceTransitionOptions = Readonly<{
  unresolvedChangesPolicy?: WorkspaceCloseUnresolvedChangesPolicy;
}>;

const DIRECT_TRANSITIONS: Readonly<
  Record<WorkspaceState, readonly WorkspaceState[]>
> = {
  empty: ["preparing"],
  preparing: ["cloning"],
  cloning: ["ready"],
  ready: ["dirty", "closed"],
  dirty: ["committed"],
  committed: ["pushed"],
  pushed: ["pr_opened"],
  pr_opened: [],
  failed: [],
  closed: [],
};

export function assertValidWorkspaceTransition(
  fromState: WorkspaceState,
  toState: WorkspaceState,
  options: WorkspaceTransitionOptions = {},
): void {
  if (fromState === toState) {
    throw createInvalidTransitionError(fromState, toState, "no state change");
  }

  if (toState === "failed") {
    return;
  }

  if (fromState === "dirty" && toState === "closed") {
    assertDirtyClosePolicy(fromState, toState, options);
    return;
  }

  if (!DIRECT_TRANSITIONS[fromState].includes(toState)) {
    throw createInvalidTransitionError(
      fromState,
      toState,
      "transition is not allowed",
    );
  }
}

export function isValidWorkspaceTransition(
  fromState: WorkspaceState,
  toState: WorkspaceState,
  options: WorkspaceTransitionOptions = {},
): boolean {
  try {
    assertValidWorkspaceTransition(fromState, toState, options);
    return true;
  } catch (error) {
    if (error instanceof Error) {
      return false;
    }
    throw error;
  }
}

function assertDirtyClosePolicy(
  fromState: WorkspaceState,
  toState: WorkspaceState,
  options: WorkspaceTransitionOptions,
): void {
  if (options.unresolvedChangesPolicy === "allow_close") {
    return;
  }

  throw createInvalidTransitionError(
    fromState,
    toState,
    "dirty workspaces require an explicit unresolved-change policy to close",
  );
}
