import { describe, expect, it } from "vitest";
import { Run } from "../run/index.js";
import {
  buildAgenticLoopWorkspaceContext,
  createRunContinuationState,
} from "./RunContinuationContext.js";

describe("RunContinuationContext", () => {
  it("captures completed edits and the last failure from a finished run", () => {
    const run = new Run("run-1", "session-1", "COMPLETED", "coding", {
      agentType: "coding",
      prompt: "make the hero prettier",
      sessionId: "session-1",
    });
    run.output = {
      content: "The hero cards were added, but the git commit step failed.",
    };
    run.metadata.agenticLoop = {
      enabled: true,
      stopReason: "tool_error",
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "write_file",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          metadata: {
            family: "edit",
            filePath: "src/components/Hero.tsx",
            additions: 20,
            deletions: 3,
            restorationContent: "export const Hero = () => null;\n",
          },
        },
        {
          toolCallId: "tool-1b",
          toolName: "git_branch_create",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Created and switched to feat/floating-hero-carousels",
          metadata: {
            family: "git",
            displayText: "Creating branch",
            pluginLabel: "GitHub",
            preview: "feat/floating-hero-carousels",
          },
        },
        {
          toolCallId: "tool-2",
          toolName: "bash",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Invalid command argument: multiline values are not allowed",
          metadata: {
            family: "shell",
            command: 'git commit -m "feat: add hero\n\nbody"',
            origin: "agent_tool",
            truncated: false,
          },
        },
      ],
    };

    const continuation = createRunContinuationState(run);

    expect(continuation).toMatchObject({
      previousPrompt: "make the hero prettier",
      previousStopReason: "tool_error",
      completedFiles: ["src/components/Hero.tsx"],
      restorableEdits: [
        {
          filePath: "src/components/Hero.tsx",
          content: "export const Hero = () => null;\n",
        },
      ],
      completedGitSteps: ["Branch created: feat/floating-hero-carousels"],
      activeBranch: "feat/floating-hero-carousels",
      failedToolName: "bash",
    });
  });

  it("does not let a failed push target branch override the proven workspace branch", () => {
    const run = new Run("run-1b", "session-1", "COMPLETED", "coding", {
      agentType: "coding",
      prompt: "push the branch",
      sessionId: "session-1",
      repositoryContext: {
        owner: "acme",
        repo: "career-crew",
        branch: "main",
      },
    });
    run.metadata.agenticLoop = {
      enabled: true,
      stopReason: "tool_error",
      toolLifecycle: [
        {
          toolCallId: "tool-commit",
          toolName: "git_commit",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Changes committed",
          metadata: {
            family: "git",
            displayText: "Creating git commit",
            preview: "feat: add coming soon indicator",
          },
        },
        {
          toolCallId: "tool-push",
          toolName: "git_push",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "error: src refspec style/redesign-footer does not match any",
          metadata: {
            family: "git",
            displayText: "Pushing branch",
            branch: "style/redesign-footer",
            preview: "style/redesign-footer",
          },
        },
      ],
    };

    const continuation = createRunContinuationState(run);
    expect(continuation?.activeBranch).toBe("main");
    expect(continuation?.hasTrustedGitCommitIdentity).toBe(false);
  });

  it("marks continuation commits as trusted only when git commit used OAuth-backed identity", () => {
    const run = new Run("run-1c", "session-1", "COMPLETED", "coding", {
      agentType: "coding",
      prompt: "commit and push",
      sessionId: "session-1",
    });
    run.metadata.agenticLoop = {
      enabled: true,
      stopReason: "tool_error",
      toolLifecycle: [
        {
          toolCallId: "tool-commit",
          toolName: "git_commit",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Changes committed",
          metadata: {
            family: "git",
            displayText: "Creating git commit",
            commitIdentitySource: "github_profile",
            commitIdentityVerified: true,
          },
        },
        {
          toolCallId: "tool-push",
          toolName: "git_push",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Push failed",
          metadata: {
            family: "git",
            displayText: "Pushing branch",
            branch: "feat/floating-hero-carousels",
          },
        },
      ],
    };

    const continuation = createRunContinuationState(run);
    expect(continuation?.hasTrustedGitCommitIdentity).toBe(true);
  });

  it("does not trust continuation commits when OAuth identity is unverified", () => {
    const run = new Run("run-1d", "session-1", "COMPLETED", "coding", {
      agentType: "coding",
      prompt: "commit and push",
      sessionId: "session-1",
    });
    run.metadata.agenticLoop = {
      enabled: true,
      stopReason: "tool_error",
      toolLifecycle: [
        {
          toolCallId: "tool-commit",
          toolName: "git_commit",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Changes committed",
          metadata: {
            family: "git",
            displayText: "Creating git commit",
            commitIdentitySource: "github_profile",
            commitIdentityVerified: false,
          },
        },
      ],
    };

    const continuation = createRunContinuationState(run);
    expect(continuation?.hasTrustedGitCommitIdentity).toBe(false);
  });

  it("adds explicit resume guidance for short continuation prompts", () => {
    const workspaceContext = buildAgenticLoopWorkspaceContext({
      repositoryContext: {
        owner: "acme",
        repo: "career-crew",
        branch: "main",
      },
      prompt: "continue?",
      continuation: {
        previousPrompt: "add floating carousels and commit the changes",
        previousOutput:
          "I couldn't finish the git step in the sandbox. Retry the step or run it locally.",
        previousStopReason: "tool_error",
        completedFiles: ["src/components/landing/hero/FloatingCarousels.tsx"],
        restorableEdits: [],
        completedGitSteps: [
          "Branch created: feat/floating-hero-carousels",
          "Commit created: feat: add floating carousels to hero section",
        ],
        activeBranch: "feat/floating-hero-carousels",
        failedToolName: "bash",
        failedToolDetail:
          "Invalid command argument: multiline values are not allowed",
        failedCommand:
          'git add src/components/landing/hero/FloatingCarousels.tsx && git commit -m "feat: add floating carousels\n\nbody"',
        recordedAt: new Date().toISOString(),
      },
    });

    expect(workspaceContext).toContain("Continuation context:");
    expect(workspaceContext).toContain(
      "Files already changed in the workspace: src/components/landing/hero/FloatingCarousels.tsx",
    );
    expect(workspaceContext).toContain(
      "Git progress already completed in this workspace:",
    );
    expect(workspaceContext).toContain(
      "Resume on branch: feat/floating-hero-carousels",
    );
    expect(workspaceContext).toContain(
      "Prefer shell/bash for local git recovery by default. Use typed git tools only when they simplify a structured step like stage/commit/push.",
    );
  });

  it("carries forward restorable edits when a recycled turn restores files but makes no new edits", () => {
    const run = new Run("run-restore-carry", "session-1", "COMPLETED", "coding", {
      agentType: "coding",
      prompt: "continue?",
      sessionId: "session-1",
    });
    run.metadata.continuation = {
      previousPrompt: "add floating carousel",
      previousStopReason: "tool_error",
      completedFiles: ["src/components/landing/hero/index.tsx"],
      restorableEdits: [
        {
          filePath: "src/components/landing/hero/index.tsx",
          content: "export const hero = 'floating';\n",
        },
      ],
      completedGitSteps: [],
      recordedAt: new Date().toISOString(),
    };
    run.metadata.workspaceBootstrap = {
      requested: true,
      bootstrapMode: "mutation",
      resolvedBy: "classifier",
      clonedDuringBootstrap: true,
      repositoryIdentity: "acme/career-crew",
      repositoryContext: {
        owner: "acme",
        repo: "career-crew",
      },
      hydratedAt: new Date().toISOString(),
    };
    run.metadata.agenticLoop = {
      enabled: true,
      stopReason: "tool_error",
      toolLifecycle: [
        {
          toolCallId: "tool-shell-fail",
          toolName: "bash",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "git push failed",
          metadata: {
            family: "shell",
            command: "git push",
            origin: "agent_tool",
            truncated: false,
          },
        },
      ],
    };

    const continuation = createRunContinuationState(run);

    expect(continuation?.restorableEdits).toEqual([
      {
        filePath: "src/components/landing/hero/index.tsx",
        content: "export const hero = 'floating';\n",
      },
    ]);
  });

  it("adds PR-specific recovery guidance when gh pr create failed through bash", () => {
    const workspaceContext = buildAgenticLoopWorkspaceContext({
      prompt: "continue?",
      continuation: {
        previousPrompt: "commit, push, and open a PR",
        previousStopReason: "tool_error",
        previousOutput:
          "The branch was pushed, but the PR step failed before GitHub accepted it.",
        completedFiles: ["src/components/landing/hero/FloatingCarousels.tsx"],
        restorableEdits: [],
        completedGitSteps: [
          "Branch created: feat/floating-hero-carousels",
          "Commit created: feat: add floating carousels to hero section",
          "Branch pushed: feat/floating-hero-carousels",
        ],
        failedToolName: "bash",
        failedToolDetail:
          "Invalid arguments for tool bash: command exceeded the maximum length",
        failedCommand:
          'gh pr create --base main --head feat/floating-hero-carousels --title "feat: add floating carousels to hero section" --body "too much text"',
        recordedAt: new Date().toISOString(),
      },
    });

    expect(workspaceContext).toContain(
      "For pull-request metadata and checks, prefer connector reads first. Use github_pr_list to discover the active PR and avoid gh shell commands unless the user explicitly requested gh.",
    );
    expect(workspaceContext).toContain(
      "Branch pushed: feat/floating-hero-carousels",
    );
    expect(workspaceContext).toContain(
      "Do not repeat successful inspection or rewrite already-updated files unless the current workspace proves the change is missing.",
    );
  });

  it("treats failed non-fast-forward pushes as committed local progress", () => {
    const workspaceContext = buildAgenticLoopWorkspaceContext({
      prompt: "continue?",
      continuation: {
        previousPrompt: "commit, push, and open a PR",
        previousStopReason: "tool_error",
        previousOutput:
          "Push failed because the remote branch had newer commits.",
        completedFiles: [
          "src/components/landing/hero/FloatingCarousels.tsx",
          "src/components/landing/hero/index.tsx",
        ],
        restorableEdits: [],
        completedGitSteps: [
          "Branch created: feat/floating-hero-carousels",
          "Commit created: feat: add floating carousels to hero section",
        ],
        failedToolName: "git_push",
        failedToolDetail:
          "Push failed because origin/feat/floating-hero-carousels already has newer commits. Your file changes are already committed locally.",
        recordedAt: new Date().toISOString(),
      },
    });

    expect(workspaceContext).toContain(
      "The previous push failed after the changes were already committed locally. A clean working tree does not mean the edits were lost.",
    );
    expect(workspaceContext).toContain(
      "Do not recreate or recommit files. Sync the branch with git_pull and retry git_push.",
    );
  });

  it("includes bootstrap readiness and git strategy hints in workspace context", () => {
    const workspaceContext = buildAgenticLoopWorkspaceContext({
      prompt: "inspect PR 228 checks and fix failing tests",
      workspaceBootstrap: {
        requested: true,
        ready: true,
        status: "ready",
        mode: "git_write",
        blocked: false,
        expectedMiss: false,
        recordedAt: new Date().toISOString(),
      },
      gitTaskStrategy: {
        classification: "mutate_fix",
        preferredLane: "github_connector",
        fallbackLane: "shell_git",
        rationale:
          "Inspect checks first, then continue with mutation-capable local repair.",
        recordedAt: new Date().toISOString(),
      },
    });

    expect(workspaceContext).toContain(
      "Workspace bootstrap state: ready (status=ready, mode=git_write).",
    );
    expect(workspaceContext).toContain(
      "Git/GitHub strategy hint: mutate_fix -> github_connector (fallback: shell_git).",
    );
    expect(workspaceContext).toContain("Strategy rationale:");
  });

  it("does not re-ask for diff scope when continuation prompt provides explicit scope", () => {
    const workspaceContext = buildAgenticLoopWorkspaceContext({
      prompt: "continue with README.md only",
      continuation: {
        previousPrompt: "commit and push",
        previousStopReason: "tool_error",
        previousOutput: "Scope clarification required.",
        completedFiles: [],
        restorableEdits: [],
        completedGitSteps: [],
        failedToolName: "git_stage",
        failedToolDetail:
          "Before staging/committing/pushing, I need one scope decision because the current local diff scope is ambiguous.",
        recordedAt: new Date().toISOString(),
      },
    });

    expect(workspaceContext).toContain("Continuation context:");
    expect(workspaceContext).not.toContain(
      "Local diff scope decision is still required.",
    );
  });
});
