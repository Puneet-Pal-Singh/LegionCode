import { describe, expect, it } from "vitest";
import {
  assertValidWorkspaceTransition,
  isValidWorkspaceTransition,
  type WorkspaceState,
} from "./state-machine.js";

describe("workspace state machine", () => {
  it("accepts the canonical happy-path transition chain", () => {
    const transitions: readonly (readonly [WorkspaceState, WorkspaceState])[] = [
      ["empty", "preparing"],
      ["preparing", "cloning"],
      ["cloning", "ready"],
      ["ready", "dirty"],
      ["dirty", "committed"],
      ["committed", "pushed"],
      ["pushed", "pr_opened"],
    ];

    for (const [fromState, toState] of transitions) {
      assertValidWorkspaceTransition(fromState, toState);
    }
  });

  it("allows any non-failed state to transition to failed", () => {
    const states: readonly WorkspaceState[] = [
      "empty",
      "preparing",
      "cloning",
      "ready",
      "dirty",
      "committed",
      "pushed",
      "pr_opened",
      "closed",
    ];

    for (const state of states) {
      expect(isValidWorkspaceTransition(state, "failed")).toBe(true);
    }
  });

  it("rejects skipped lifecycle transitions", () => {
    expect(() => assertValidWorkspaceTransition("ready", "pushed")).toThrow(
      expect.objectContaining({
        code: "workspace_transition_invalid",
      }),
    );
  });

  it("rejects same-state transitions", () => {
    expect(isValidWorkspaceTransition("ready", "ready")).toBe(false);
  });

  it("requires explicit unresolved-change policy for dirty workspace closure", () => {
    expect(isValidWorkspaceTransition("dirty", "closed")).toBe(false);
    expect(
      isValidWorkspaceTransition("dirty", "closed", {
        unresolvedChangesPolicy: "allow_close",
      }),
    ).toBe(true);
  });
});
