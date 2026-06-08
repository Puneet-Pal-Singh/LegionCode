import { describe, expect, it } from "vitest";
import { evaluateWorkspaceBootstrap } from "./RunPermissionWorkspacePolicy.js";
import type { WorkspaceBootstrapper } from "../types.js";

describe("RunPermissionWorkspacePolicy", () => {
  it("skips workspace bootstrap for prompts without workspace intent", async () => {
    const workspaceBootstrapper: WorkspaceBootstrapper = {
      bootstrap: async () => {
        throw new Error("bootstrap should not run without workspace intent");
      },
    };

    const evaluation = await evaluateWorkspaceBootstrap(
      "run-chat",
      "what should we do today?",
      {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
      workspaceBootstrapper,
    );

    expect(evaluation).toMatchObject({
      status: "skipped",
      blocked: false,
      message: null,
    });
  });

  it("returns actionable guidance when branch switch is blocked by local checkout conflicts", async () => {
    const workspaceBootstrapper: WorkspaceBootstrapper = {
      bootstrap: async () => ({
        status: "sync-failed",
        message:
          "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/components/layout/Footer.tsx\nPlease commit your changes or stash them before you switch branches.\nAborting",
      }),
    };

    const evaluation = await evaluateWorkspaceBootstrap(
      "run-1",
      "continue",
      {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "style/redesign-footer",
      },
      workspaceBootstrapper,
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.status).toBe("sync-failed");
    expect(evaluation.message).toContain(
      "switching to `style/redesign-footer` would overwrite local changes",
    );
    expect(evaluation.message).toContain(
      "Conflicting file(s): src/components/layout/Footer.tsx.",
    );
    expect(evaluation.message).toContain("No local edits were discarded.");
    expect(evaluation.message).toContain(
      "Commit or stash those edits first, then retry the action.",
    );
  });

  it("returns friendly guidance when bootstrap fails due to transient local dev session proxy misses", async () => {
    const workspaceBootstrapper: WorkspaceBootstrapper = {
      bootstrap: async () => ({
        status: "sync-failed",
        message:
          "Couldn't find a local dev session for the \"default\" entrypoint of service \"shadowbox-api\" to proxy to",
      }),
    };

    const evaluation = await evaluateWorkspaceBootstrap(
      "run-2",
      "continue",
      {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
      workspaceBootstrapper,
    );

    expect(evaluation.blocked).toBe(true);
    expect(evaluation.status).toBe("sync-failed");
    expect(evaluation.message).toBe(
      "I couldn't prepare the workspace for sourcegraph/shadowbox@main because the git service is temporarily unavailable. Please retry in a few seconds.",
    );
  });
});
