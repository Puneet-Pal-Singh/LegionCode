import { describe, expect, it } from "vitest";
import type { RuntimeExecutionService } from "../types.js";
import {
  executeAgenticLoopTool,
  normalizeWorkspacePath,
} from "./AgenticLoopToolExecutor.js";

describe("AgenticLoopToolExecutor", () => {
  it("preserves leading @ for workspace-scoped paths", () => {
    expect(normalizeWorkspacePath(" '@types/foo.ts', ")).toBe("@types/foo.ts");
    expect(normalizeWorkspacePath('"@scope/pkg";')).toBe("@scope/pkg");
  });

  it("routes normalized multi-file edits through the filesystem plugin", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { success: true, output: "Edited 2 files" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-edit-1",
      toolName: "multi_edit",
      toolInput: {
        edits: [
          { path: "src/a.ts", oldText: "one", newText: "two" },
          { path: "src/b.ts", oldText: "three", newText: "four" },
        ],
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "filesystem",
        action: "multi_edit",
        payload: {
          edits: [
            { path: "src/a.ts", oldText: "one", newText: "two" },
            { path: "src/b.ts", oldText: "three", newText: "four" },
          ],
        },
      },
    ]);
  });

  it("rejects traversal in edit paths before plugin execution", async () => {
    let executeCallCount = 0;
    const executionService: RuntimeExecutionService = {
      execute: async () => {
        executeCallCount += 1;
        return { success: true };
      },
    };

    await expect(
      executeAgenticLoopTool(executionService, {
        taskId: "task-edit-traversal",
        toolName: "edit_file",
        toolInput: {
          path: "../outside.ts",
          oldText: "one",
          newText: "two",
        },
      }),
    ).rejects.toThrow(/traversal/i);
    expect(executeCallCount).toBe(0);
  });

  it("executes github_pr_list through the github bridge route", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-1",
      toolName: "github_pr_list",
      toolInput: {
        description: "List PRs",
        owner: "Puneet-Pal-Singh",
        repo: "career-crew",
        state: "open",
        head: " feat/admin-panel-get-all-jobs-feature ",
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "github",
        action: "pr_list",
        payload: {
          owner: "Puneet-Pal-Singh",
          repo: "career-crew",
          state: "open",
          head: "feat/admin-panel-get-all-jobs-feature",
        },
      },
    ]);
  });

  it("executes github_cli_actions_job_logs_get through the bounded github_cli route", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-github-cli-1",
      toolName: "github_cli_actions_job_logs_get",
      toolInput: {
        owner: "acme",
        repo: "career-crew",
        actionsJobId: 987654,
        tailLines: 200,
        __runtimeFeatureFlags: {
          ghCliLaneEnabled: true,
          ghCliCiEnabled: true,
          ghCliPrCommentEnabled: true,
        },
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "github_cli",
        action: "actions_job_logs_get",
        payload: {
          owner: "acme",
          repo: "career-crew",
          actionsJobId: 987654,
          tailLines: 200,
          ghCliLaneEnabled: true,
          ghCliCiEnabled: true,
          ghCliPrCommentEnabled: true,
        },
      },
    ]);
  });

  it("executes github_cli_pr_comment as a bounded GitHub mutation", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-github-cli-comment-1",
      toolName: "github_cli_pr_comment",
      toolInput: {
        owner: "acme",
        repo: "career-crew",
        number: 228,
        body: "Looks good to me.",
        __runtimeFeatureFlags: {
          ghCliLaneEnabled: true,
          ghCliCiEnabled: true,
          ghCliPrCommentEnabled: true,
        },
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "github_cli",
        action: "pr_comment",
        payload: {
          owner: "acme",
          repo: "career-crew",
          number: 228,
          body: "Looks good to me.",
          ghCliLaneEnabled: true,
          ghCliCiEnabled: true,
          ghCliPrCommentEnabled: true,
        },
      },
    ]);
  });

  it("fails github_cli_pr_comment when the runtime feature flag disables PR comments", async () => {
    let executeCallCount = 0;
    const executionService: RuntimeExecutionService = {
      execute: async () => {
        executeCallCount += 1;
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-github-cli-comment-2",
      toolName: "github_cli_pr_comment",
      toolInput: {
        owner: "acme",
        repo: "career-crew",
        number: 228,
        body: "Looks good to me.",
        __runtimeFeatureFlags: {
          ghCliLaneEnabled: true,
          ghCliCiEnabled: true,
          ghCliPrCommentEnabled: false,
        },
      },
    });

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("GH_CLI_PR_COMMENT_ENABLED");
    expect(executeCallCount).toBe(0);
  });

  it("fails github_cli_actions_job_logs_get when runtime flags are missing (fail-closed)", async () => {
    let executeCallCount = 0;
    const executionService: RuntimeExecutionService = {
      execute: async () => {
        executeCallCount += 1;
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-github-cli-logs-flag-missing",
      toolName: "github_cli_actions_job_logs_get",
      toolInput: {
        owner: "acme",
        repo: "career-crew",
        actionsJobId: 987654,
      },
    });

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("GH_CLI_LANE_ENABLED");
    expect(executeCallCount).toBe(0);
  });

  it("fails github_cli_actions_job_logs_get when CI flag is missing even if lane is enabled", async () => {
    let executeCallCount = 0;
    const executionService: RuntimeExecutionService = {
      execute: async () => {
        executeCallCount += 1;
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-github-cli-logs-ci-flag-missing",
      toolName: "github_cli_actions_job_logs_get",
      toolInput: {
        owner: "acme",
        repo: "career-crew",
        actionsJobId: 987654,
        __runtimeFeatureFlags: {
          ghCliLaneEnabled: true,
          ghCliPrCommentEnabled: true,
        },
      },
    });

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain("GH_CLI_CI_ENABLED");
    expect(executeCallCount).toBe(0);
  });

  it("blocks bash git config user identity commands and avoids execution", async () => {
    let executeCallCount = 0;
    const executionService: RuntimeExecutionService = {
      execute: async () => {
        executeCallCount += 1;
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-2",
      toolName: "bash",
      toolInput: {
        description: "Set git identity in shell",
        command:
          'git config user.email "agent@shadowbox.ai" && git config user.name "Shadowbox Agent"',
      },
    });

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain(
      "Do not run git config user.name/user.email through bash",
    );
    expect(executeCallCount).toBe(0);
  });

  it("blocks generic git commands in bash and avoids execution", async () => {
    let executeCallCount = 0;
    const executionService: RuntimeExecutionService = {
      execute: async () => {
        executeCallCount += 1;
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-3",
      toolName: "bash",
      toolInput: {
        description: "Switch branch from bash",
        command:
          "git checkout style/redesign-footer -- src/components/layout/Footer.tsx",
      },
    });

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain(
      "Do not run git commands through bash in agent flow",
    );
    expect(executeCallCount).toBe(0);
  });

  it("blocks chained git commands in bash and avoids execution", async () => {
    let executeCallCount = 0;
    const executionService: RuntimeExecutionService = {
      execute: async () => {
        executeCallCount += 1;
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-3b",
      toolName: "bash",
      toolInput: {
        description: "Run prep then git",
        command: "pwd && git status --short",
      },
    });

    expect(result.status).toBe("FAILED");
    expect(result.error?.message).toContain(
      "Do not run git commands through bash in agent flow",
    );
    expect(executeCallCount).toBe(0);
  });

  it("still routes ordinary non-git bash commands through the bash gateway", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { output: "ok" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-3",
      toolName: "bash",
      toolInput: {
        description: "Print state",
        command: "echo hello",
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "bash",
        action: "run",
        payload: {
          command: "echo hello",
          description: "Print state",
        },
      },
    ]);
  });

  it("routes simple cat file reads through read_file instead of bash", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { output: "file-content" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-4",
      toolName: "bash",
      toolInput: {
        description: "Read footer",
        command: "cat src/components/layout/Footer.tsx",
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "filesystem",
        action: "read_file",
        payload: {
          path: "src/components/layout/Footer.tsx",
        },
      },
    ]);
  });

  it("forwards read_file offset and limit to the filesystem route", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { output: "window-content" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-read-window",
      toolName: "read_file",
      toolInput: {
        path: "src/components/landing/hero/index.tsx",
        offset: 100,
        limit: 250,
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "filesystem",
        action: "read_file",
        payload: {
          path: "src/components/landing/hero/index.tsx",
          offset: 100,
          limit: 250,
        },
      },
    ]);
  });

  it("clamps oversized read_file limits to the runtime maximum", async () => {
    const calls: Array<{
      plugin: string;
      action: string;
      payload: Record<string, unknown>;
    }> = [];
    const executionService: RuntimeExecutionService = {
      execute: async (plugin, action, payload) => {
        calls.push({ plugin, action, payload });
        return { output: "window-content" };
      },
    };

    const result = await executeAgenticLoopTool(executionService, {
      taskId: "task-read-large-window",
      toolName: "read_file",
      toolInput: {
        path: "src/components/landing/hero/index.tsx",
        limit: 10_000,
      },
    });

    expect(result.status).toBe("DONE");
    expect(calls).toEqual([
      {
        plugin: "filesystem",
        action: "read_file",
        payload: {
          path: "src/components/landing/hero/index.tsx",
          limit: 1_000,
        },
      },
    ]);
  });
});
