import { describe, expect, it } from "vitest";
import {
  buildAgenticLoopFinalOutput,
  buildAgenticLoopFinalMessage,
  getAgenticLoopMaxSteps,
  recordAgenticLoopMetadata,
  TASK_MODEL_NO_ACTION_CODE,
} from "./RunAgenticLoopPolicy.js";
import { Run } from "../run/index.js";
import type { AgenticLoopResult } from "./AgenticLoop.js";

describe("RunAgenticLoopPolicy", () => {
  it("prefers assistant synthesis when the loop ends normally", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "inspect the file" },
        {
          role: "assistant",
          content: "The file contains the expected export.",
        },
      ],
      toolExecutionCount: 1,
      failedToolCount: 0,
      stepsExecuted: 2,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "completed",
          mutating: false,
          recordedAt: new Date().toISOString(),
          detail: "export const value = 1;",
        },
      ],
    };

    expect(buildAgenticLoopFinalOutput(result)).toBe(
      "The file contains the expected export.",
    );
  });

  it("extracts assistant synthesis from structured text parts", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "check git info" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tool-1",
              toolName: "git_status",
              args: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool-1",
              toolName: "git_status",
              output: { branch: "main", files: [] },
              isError: false,
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "You're on main and the working tree is clean.",
            },
          ],
        },
      ],
      toolExecutionCount: 1,
      failedToolCount: 0,
      stepsExecuted: 2,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [],
    };

    expect(buildAgenticLoopFinalOutput(result)).toBe(
      "You're on main and the working tree is clean.",
    );
  });

  it("prefers grounded edit evidence over vague assistant prose for successful mutation runs", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "make the job detail page more useful" },
        {
          role: "assistant",
          content: "Now let me enhance the value proposition sections.",
        },
      ],
      toolExecutionCount: 3,
      failedToolCount: 0,
      stepsExecuted: 4,
      requiresMutation: true,
      completedMutatingToolCount: 2,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "write_file",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "updated src/components/jobs/JobDetailView.tsx",
          metadata: {
            family: "edit",
            filePath: "src/components/jobs/JobDetailView.tsx",
            additions: 18,
            deletions: 6,
          },
        },
        {
          toolCallId: "tool-2",
          toolName: "write_file",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "updated src/components/jobs/job-detail/JobSidebar.tsx",
          metadata: {
            family: "edit",
            filePath: "src/components/jobs/job-detail/JobSidebar.tsx",
            additions: 12,
            deletions: 4,
          },
        },
      ],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toContain(
      "I completed the requested update and changed 2 files:",
    );
    expect(output).toContain("src/components/jobs/JobDetailView.tsx (+18 -6)");
    expect(output).toContain(
      "src/components/jobs/job-detail/JobSidebar.tsx (+12 -4)",
    );
    expect(output).toContain(
      "Updated sections/components: JobDetailView, JobSidebar",
    );
    expect(output).not.toContain(
      "Now let me enhance the value proposition sections.",
    );
  });

  it("builds a truthful fallback summary when the loop stops on tool failure", () => {
    const result: AgenticLoopResult = {
      stopReason: "tool_error",
      messages: [
        { role: "user", content: "update the file" },
        { role: "assistant", content: "I'll update the file now." },
      ],
      toolExecutionCount: 2,
      failedToolCount: 1,
      stepsExecuted: 1,
      requiresMutation: true,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "completed",
          mutating: false,
          recordedAt: new Date().toISOString(),
          detail: "README contents",
        },
        {
          toolCallId: "tool-2",
          toolName: "write_file",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Permission denied",
        },
      ],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toContain(
      "I inspected the workspace, but I did not complete the requested change because no mutating tool succeeded.",
    );
    expect(output).toContain(
      "Before the run stopped, I completed 1 inspection step(s) to gather workspace evidence.",
    );
    expect(output).toContain(
      "A required file edit step failed: Permission denied",
    );
    expect(output).not.toContain("I'll update the file now.");
  });

  it("does not emit incomplete-mutation copy for read-only current turn intent", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "check ci checks passed or not" },
        {
          role: "assistant",
          content: "CI checks are still running on the latest commit.",
        },
      ],
      toolExecutionCount: 0,
      failedToolCount: 0,
      stepsExecuted: 1,
      requiresMutation: true,
      currentTurnIntent: "read_only",
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [],
    };

    const output = buildAgenticLoopFinalOutput(result);
    expect(output).toBe("CI checks are still running on the latest commit.");
    expect(output).not.toContain("did not complete the requested change");
  });

  it("explains missing sandbox cwd failures without dumping raw tool telemetry", () => {
    const result: AgenticLoopResult = {
      stopReason: "tool_error",
      messages: [
        {
          role: "user",
          content: "make the hero prettier with floating carousels",
        },
      ],
      toolExecutionCount: 3,
      failedToolCount: 1,
      stepsExecuted: 3,
      requiresMutation: true,
      completedMutatingToolCount: 1,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "write_file",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "updated src/components/landing/hero/FloatingCarousels.tsx",
          metadata: {
            family: "edit",
            filePath: "src/components/landing/hero/FloatingCarousels.tsx",
            additions: 42,
            deletions: 0,
          },
        },
        {
          toolCallId: "tool-2",
          toolName: "bash",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail:
            "bash: line 1: cd: /home/user/repos/career-crew: No such file or directory",
          metadata: {
            family: "shell",
            command:
              "cd /home/user/repos/career-crew && npx next lint --file src/components/landing/hero/FloatingCarousels.tsx",
            cwd: ".",
            origin: "agent_tool",
            stderr:
              "bash: line 1: cd: /home/user/repos/career-crew: No such file or directory",
            truncated: false,
          },
        },
      ],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toContain(
      "I completed the requested update and changed this file:",
    );
    expect(output).toContain(
      "A shell step failed because it tried to change into /home/user/repos/career-crew, which does not exist in this sandbox.",
    );
    expect(output).toContain("run it in your local terminal");
    expect(output).not.toContain("tool-2");
  });

  it("marks tool failures as recoverable with a user-facing retry hint", () => {
    const result: AgenticLoopResult = {
      stopReason: "tool_error",
      messages: [{ role: "user", content: "commit the updated files" }],
      toolExecutionCount: 2,
      failedToolCount: 1,
      stepsExecuted: 2,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "git_status",
          status: "completed",
          mutating: false,
          recordedAt: new Date().toISOString(),
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
            command:
              'git add src/components/Hero.tsx && git commit -m "feat: add hero\n\nbody"',
            origin: "agent_tool",
            truncated: false,
          },
        },
      ],
    };

    const finalMessage = buildAgenticLoopFinalMessage(result);

    expect(finalMessage.text).toContain(
      "I couldn't finish the git step in the sandbox because the shell command was malformed for the bounded executor.",
    );
    expect(finalMessage.metadata).toMatchObject({
      code: "TOOL_EXECUTION_FAILED",
      retryable: true,
      resumeActions: ["retry", "open_terminal"],
    });
    expect(finalMessage.metadata?.resumeHint).toContain(
      "finish the remaining git command in your local terminal",
    );
  });

  it("describes completed git mutations as repository-changing work", () => {
    const result: AgenticLoopResult = {
      stopReason: "tool_error",
      messages: [{ role: "user", content: "push the branch" }],
      toolExecutionCount: 2,
      failedToolCount: 1,
      stepsExecuted: 2,
      requiresMutation: true,
      completedMutatingToolCount: 1,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "git_commit",
          status: "completed",
          mutating: true,
          recordedAt: "2026-04-05T00:00:00.000Z",
        },
        {
          toolCallId: "tool-2",
          toolName: "git_push",
          status: "failed",
          mutating: true,
          recordedAt: "2026-04-05T00:00:01.000Z",
          detail: "non-fast-forward",
        },
      ],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toContain(
      "Before the run stopped, I completed 1 repository step(s) that changed branch or commit state.",
    );
  });

  it("uses the terminal failed tool when building retry metadata", () => {
    const finalMessage = buildAgenticLoopFinalMessage({
      stopReason: "tool_error",
      messages: [{ role: "user", content: "continue?" }],
      toolExecutionCount: 3,
      failedToolCount: 2,
      stepsExecuted: 3,
      requiresMutation: true,
      completedMutatingToolCount: 1,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "git_push",
          status: "failed",
          mutating: true,
          recordedAt: "2026-04-05T00:00:01.000Z",
          detail: "non-fast-forward",
        },
        {
          toolCallId: "tool-2",
          toolName: "bash",
          status: "failed",
          mutating: true,
          recordedAt: "2026-04-05T00:00:02.000Z",
          detail:
            "bash: line 1: cd: /home/user/repos/career-crew: No such file or directory",
          metadata: {
            family: "shell",
            command: "cd /home/user/repos/career-crew && npm test",
            cwd: ".",
            origin: "agent_tool",
            stderr:
              "bash: line 1: cd: /home/user/repos/career-crew: No such file or directory",
            truncated: false,
          },
        },
      ],
    });

    expect(finalMessage.metadata?.resumeHint).toContain(
      "Retry the step from the workspace root.",
    );
    expect(finalMessage.text).toContain(
      "tried to change into /home/user/repos/career-crew",
    );
  });

  it("explains gh pr create bash failures as dedicated PR-tool recovery", () => {
    const result: AgenticLoopResult = {
      stopReason: "tool_error",
      messages: [{ role: "user", content: "create a PR" }],
      toolExecutionCount: 5,
      failedToolCount: 1,
      stepsExecuted: 5,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 4,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "git_push",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
        },
        {
          toolCallId: "tool-2",
          toolName: "bash",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail:
            "Invalid arguments for tool bash: command exceeded the maximum length",
          metadata: {
            family: "shell",
            command:
              'gh pr create --base main --head feat/floating-hero-carousels --title "feat: add floating carousels to hero section" --body "too much text"',
            origin: "agent_tool",
            truncated: false,
          },
        },
      ],
    };

    const finalMessage = buildAgenticLoopFinalMessage(result);

    expect(finalMessage.text).toContain(
      "I couldn't finish the pull request step because it was attempted through bash instead of the dedicated GitHub-backed PR action.",
    );
    expect(finalMessage.metadata?.resumeHint).toContain(
      "Retry the pull request step so it uses the dedicated PR action.",
    );
  });

  it("explains non-fast-forward push failures without implying file loss", () => {
    const result: AgenticLoopResult = {
      stopReason: "tool_error",
      messages: [{ role: "user", content: "push the branch" }],
      toolExecutionCount: 4,
      failedToolCount: 1,
      stepsExecuted: 4,
      requiresMutation: true,
      completedMutatingToolCount: 2,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "write_file",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          metadata: {
            family: "edit",
            filePath: "src/components/landing/hero/FloatingCarousels.tsx",
            additions: 62,
            deletions: 0,
          },
        },
        {
          toolCallId: "tool-2",
          toolName: "git_commit",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "feat: add floating carousels to hero section",
          metadata: {
            family: "git",
            displayText: "Creating git commit",
            preview: "feat: add floating carousels to hero section",
          },
        },
        {
          toolCallId: "tool-3",
          toolName: "git_push",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail:
            "Push failed because origin/feat/floating-hero-carousels already has newer commits. Your file changes are already committed locally.",
        },
      ],
    };

    const finalMessage = buildAgenticLoopFinalMessage(result);

    expect(finalMessage.text).toContain(
      "Your file changes were already committed locally, so they were not lost.",
    );
    expect(finalMessage.metadata?.resumeHint).toContain(
      "The changes are already committed locally. Retry by syncing the branch with git_pull, then run git_push again.",
    );
  });

  it("summarizes missing package scripts with an actionable retry hint", () => {
    const finalMessage = buildAgenticLoopFinalMessage({
      stopReason: "tool_error",
      messages: [{ role: "user", content: "run pnpm test" }],
      toolExecutionCount: 1,
      failedToolCount: 1,
      stepsExecuted: 1,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "bash",
          status: "failed",
          mutating: true,
          recordedAt: "2026-04-17T14:17:37.000Z",
          detail:
            'npm error Missing script: "test" npm error To see a list of scripts, run: npm run',
          metadata: {
            family: "shell",
            command: "pnpm test",
            cwd: ".",
            origin: "agent_tool",
            stderr:
              'npm error Missing script: "test" npm error To see a list of scripts, run: npm run',
            truncated: false,
          },
        },
      ],
    });

    expect(finalMessage.text).toContain(
      'does not define a script named "test"',
    );
    expect(finalMessage.metadata?.resumeHint).toContain(
      "Run `pnpm run` (or `npm run`) to list scripts",
    );
  });

  it("explains git mutation gate failures with a retryable final message", () => {
    const finalMessage = buildAgenticLoopFinalMessage({
      stopReason: "tool_error",
      messages: [{ role: "user", content: "create a PR and push it" }],
      toolExecutionCount: 3,
      failedToolCount: 1,
      stepsExecuted: 3,
      requiresMutation: true,
      completedMutatingToolCount: 1,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-0",
          toolName: "git_branch_create",
          status: "completed",
          mutating: true,
          recordedAt: "2026-05-06T12:00:00.000Z",
        },
        {
          toolCallId: "tool-1",
          toolName: "git_push",
          status: "failed",
          mutating: true,
          recordedAt: "2026-05-06T12:00:01.000Z",
          detail:
            "LegionCode cannot continue with git push yet because no successful file mutation or committed-change evidence exists in this run.",
        },
      ],
    });

    expect(finalMessage.text).toContain(
      "the safety gate did not find a successful file edit",
    );
    expect(finalMessage.text).toContain(
      "No new commit or pull request was created.",
    );
    expect(finalMessage.metadata?.resumeHint).toContain(
      "Retry after committing the intended changes",
    );
  });

  it("explains missing local git refs during push recovery in plain language", () => {
    const result: AgenticLoopResult = {
      stopReason: "tool_error",
      messages: [{ role: "user", content: "continue?" }],
      toolExecutionCount: 2,
      failedToolCount: 1,
      stepsExecuted: 2,
      requiresMutation: true,
      completedMutatingToolCount: 1,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-0",
          toolName: "write_file",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          metadata: {
            family: "edit",
            filePath: "src/components/landing/hero/FloatingCarousels.tsx",
            additions: 62,
            deletions: 0,
          },
        },
        {
          toolCallId: "tool-1",
          toolName: "git_pull",
          status: "completed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail: "Already up to date",
          metadata: {
            family: "git",
            branch: "feat/floating-hero-carousels",
            preview: "feat/floating-hero-carousels",
          },
        },
        {
          toolCallId: "tool-2",
          toolName: "git_push",
          status: "failed",
          mutating: true,
          recordedAt: new Date().toISOString(),
          detail:
            "error: src refspec feat/floating-hero-carousels does not match any",
          metadata: {
            family: "git",
            branch: "feat/floating-hero-carousels",
            preview: "feat/floating-hero-carousels",
          },
        },
      ],
    };

    const finalMessage = buildAgenticLoopFinalMessage(result);

    expect(finalMessage.text).toContain(
      "the local branch ref was missing in the resumed workspace",
    );
    expect(finalMessage.metadata?.resumeHint).toContain(
      "re-opening the correct workspace branch",
    );
  });

  it("records tool lifecycle snapshots in run metadata", () => {
    const run = new Run("run-1", "session-1", "RUNNING", "coding", {
      agentType: "coding",
      prompt: "inspect repository",
      sessionId: "session-1",
    });
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [{ role: "assistant", content: "done" }],
      toolExecutionCount: 1,
      failedToolCount: 0,
      stepsExecuted: 2,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 1,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "requested",
          mutating: false,
          recordedAt: new Date().toISOString(),
        },
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "started",
          mutating: false,
          recordedAt: new Date().toISOString(),
        },
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "completed",
          mutating: false,
          recordedAt: new Date().toISOString(),
          detail: "package.json",
        },
      ],
    };

    recordAgenticLoopMetadata(run, result);

    expect(run.metadata.agenticLoop?.toolLifecycle).toEqual(
      result.toolLifecycle,
    );
    expect(run.metadata.agenticLoop?.requiresMutation).toBe(false);
    expect(run.metadata.agenticLoop?.completedReadOnlyToolCount).toBe(1);
    expect(run.metadata.agenticLoop?.llmRetryCount).toBe(0);
  });

  it("raises the default max steps to support repo discovery flows", () => {
    expect(getAgenticLoopMaxSteps()).toBe(25);
  });

  it("does not trust a read-only stop as completion for edit requests", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        {
          role: "assistant",
          content: "Done! I updated the landing page.",
        },
      ],
      toolExecutionCount: 4,
      failedToolCount: 0,
      stepsExecuted: 5,
      requiresMutation: true,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 4,
      toolLifecycle: [
        {
          toolCallId: "tool-1",
          toolName: "read_file",
          status: "completed",
          mutating: false,
          recordedAt: new Date().toISOString(),
          detail: "hero component",
        },
      ],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toContain(
      "I inspected the workspace, but I did not complete the requested change because no mutating tool succeeded.",
    );
    expect(output).toContain(
      "No file changed in this run. Retry with a more specific target file, component, or edit instruction so I can attempt the mutation again.",
    );
    expect(output).not.toContain("Done! I updated the landing page.");
  });

  it("classifies zero-action mutation runs as recoverable model stalls", () => {
    const result: AgenticLoopResult = {
      stopReason: "incomplete_mutation",
      messages: [
        { role: "user", content: "update the footer copy" },
        { role: "assistant", content: "Done." },
      ],
      toolExecutionCount: 0,
      failedToolCount: 0,
      stepsExecuted: 2,
      requiresMutation: true,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      llmRetryCount: 0,
      toolLifecycle: [],
    };

    const output = buildAgenticLoopFinalMessage(result);

    expect(output.metadata).toMatchObject({
      code: TASK_MODEL_NO_ACTION_CODE,
      retryable: true,
      resumeActions: ["retry", "switch_model"],
    });
    expect(output.text).toContain(
      "The model did not return a usable next action for this edit request.",
    );
    expect(output.text).toContain("No file was changed in this run.");
    expect(output.text).not.toContain("more specific target file");
  });

  it("preserves substantive clarification text for zero-action mutation runs", () => {
    const result: AgenticLoopResult = {
      stopReason: "incomplete_mutation",
      messages: [
        { role: "user", content: "update the footer copy" },
        {
          role: "assistant",
          content:
            "Which file should I update for the footer copy, or do you want me to choose one?",
        },
      ],
      toolExecutionCount: 0,
      failedToolCount: 0,
      stepsExecuted: 1,
      requiresMutation: true,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      llmRetryCount: 0,
      toolLifecycle: [],
    };

    const output = buildAgenticLoopFinalMessage(result);

    expect(output.metadata).toBeUndefined();
    expect(output.text).toContain(
      "Which file should I update for the footer copy, or do you want me to choose one?",
    );
  });

  it("ignores raw standalone tool-call markup when extracting assistant text", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "check file" },
        {
          role: "assistant",
          content:
            '<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>',
        },
      ],
      toolExecutionCount: 0,
      failedToolCount: 0,
      stepsExecuted: 1,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toContain(
      "I completed the tool loop, but I could not produce a final assistant answer for this run.",
    );
    expect(output).not.toContain("<tool_call>");
  });

  it("removes leaked internal-style preface and keeps only user-facing reply text", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "yo" },
        {
          role: "assistant",
          content:
            'The user said "yo". This is a greeting. I should respond politely and ask how I can help them with the repo. Yo! How can I help you today?',
        },
      ],
      toolExecutionCount: 0,
      failedToolCount: 0,
      stepsExecuted: 1,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toBe("Yo! How can I help you today?");
    expect(output).not.toContain("The user said");
    expect(output).not.toContain("I should respond");
  });

  it("falls back to synthesized summary when leaked internal preface has no user-facing reply", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "yo" },
        {
          role: "assistant",
          content:
            'The user said "yo". This is a greeting. I should respond politely.',
        },
      ],
      toolExecutionCount: 0,
      failedToolCount: 0,
      stepsExecuted: 1,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toContain(
      "I completed the tool loop, but I could not produce a final assistant answer for this run.",
    );
    expect(output).not.toContain("The user said");
    expect(output).not.toContain("I should respond");
  });

  it("removes multi-sentence internal planning preface before user-facing text", () => {
    const result: AgenticLoopResult = {
      stopReason: "llm_stop",
      messages: [
        { role: "user", content: "check my PR" },
        {
          role: "assistant",
          content:
            "The user wants me to check the PR. I need to inspect branch state first. First, I'll check git status. The current branch is main. Usually, PRs are on their own branches. Wait, I should switch branches. I found the requested issue and can fix it next.",
        },
      ],
      toolExecutionCount: 0,
      failedToolCount: 0,
      stepsExecuted: 1,
      requiresMutation: false,
      completedMutatingToolCount: 0,
      completedReadOnlyToolCount: 0,
      toolLifecycle: [],
    };

    const output = buildAgenticLoopFinalOutput(result);

    expect(output).toBe("I found the requested issue and can fix it next.");
    expect(output).not.toContain("The user wants");
    expect(output).not.toContain("I need to inspect");
    expect(output).not.toContain("Usually, PRs");
    expect(output).not.toContain("Wait, I should");
  });
});
