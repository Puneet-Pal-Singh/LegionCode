import { describe, expect, it, vi } from "vitest";
import { WorkspaceBootstrapService } from "./WorkspaceBootstrapService";

const CLEAN_GIT_STATUS_OUTPUT = JSON.stringify({
  branch: "main",
  files: [],
  ahead: 0,
  behind: 0,
  repoIdentity: "github.com/sourcegraph/shadowbox",
  hasStaged: false,
  hasUnstaged: false,
  gitAvailable: true,
});

describe("WorkspaceBootstrapService", () => {
  it("returns invalid-context when owner/repo are missing", async () => {
    const execute = vi.fn(async () => ({ success: true }));
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_100001",
      mode: "git_write",
      repositoryContext: { owner: "", repo: "" },
    });

    expect(result.status).toBe("invalid-context");
    expect(execute).not.toHaveBeenCalled();
  });

  it("clones workspace when git repository is not initialized", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "fatal: not a git repository",
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_100001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "dev",
      },
    });

    expect(result.status).toBe("ready");
    expect(result.clonedDuringBootstrap).toBe(true);
    expect(execute).toHaveBeenNthCalledWith(1, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_clone", {
      url: "https://github.com/sourcegraph/shadowbox.git",
    });
    expect(execute).toHaveBeenNthCalledWith(3, "git", "git_fetch", {
      remote: "origin",
    });
    expect(execute).toHaveBeenNthCalledWith(4, "git", "git_branch_switch", {
      branch: "dev",
    });
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("retries transient git status failures before continuing bootstrap", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "SandboxError: HTTP error! status: 500",
      })
      .mockResolvedValueOnce({
        success: true,
        output: CLEAN_GIT_STATUS_OUTPUT,
      })
      .mockResolvedValueOnce({ success: true }) // fetch
      .mockResolvedValueOnce({ success: true }) // switch
      .mockResolvedValueOnce({ success: true }); // pull
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_retrystatus001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(5);
    expect(execute).toHaveBeenNthCalledWith(1, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(3, "git", "git_fetch", {
      remote: "origin",
    });
  });

  it("retries local-dev-session proxy misses before continuing bootstrap", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error:
          'Couldn\'t find a local dev session for the "default" entrypoint of service "shadowbox-api" to proxy to',
      })
      .mockResolvedValueOnce({
        success: true,
        output: CLEAN_GIT_STATUS_OUTPUT,
      })
      .mockResolvedValueOnce({ success: true }) // fetch
      .mockResolvedValueOnce({ success: true }) // switch
      .mockResolvedValueOnce({ success: true }); // pull
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_retrylocaldev001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(5);
    expect(execute).toHaveBeenNthCalledWith(1, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_status", {});
  });

  it("returns friendly sync-failed guidance when transient status misses persist", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error:
          'Couldn\'t find a local dev session for the "default" entrypoint of service "shadowbox-api" to proxy to',
      })
      .mockResolvedValueOnce({
        success: false,
        error:
          'Couldn\'t find a local dev session for the "default" entrypoint of service "shadowbox-api" to proxy to',
      })
      .mockResolvedValueOnce({
        success: false,
        error:
          'Couldn\'t find a local dev session for the "default" entrypoint of service "shadowbox-api" to proxy to',
      });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_syncfailed001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("sync-failed");
    expect(result.message).toBe(
      "Git service is temporarily unavailable. Please retry in a few seconds.",
    );
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("returns needs-auth on git authentication failures", async () => {
    const execute = vi.fn(async () => ({
      success: false,
      error: "remote: Permission to private/repo denied to user",
    }));
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_100001",
      mode: "git_write",
      repositoryContext: {
        owner: "private",
        repo: "repo",
      },
    });

    expect(result.status).toBe("needs-auth");
  });

  it("fails fast when clone finds a non-empty non-repository workspace", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "fatal: not a git repository",
      })
      .mockResolvedValueOnce({
        success: false,
        error:
          "fatal: destination path '/home/sandbox/runs/run_100001' already exists and is not an empty directory.",
      });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_100001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "dev",
      },
    });

    expect(result.status).toBe("sync-failed");
    expect(result.message).toContain("Workspace initialization conflict");
    expect(result.message).not.toContain("fatal:");
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_clone", {
      url: "https://github.com/sourcegraph/shadowbox.git",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry clone recovery requests", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        error: "fatal: not a git repository",
      })
      .mockResolvedValueOnce({
        success: false,
        error:
          "fatal: destination path '/home/sandbox/runs/run_100001' already exists and is not an empty directory.",
      });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_100001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "dev",
      },
    });

    expect(result.status).toBe("sync-failed");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("creates branch when switch fails due to missing local branch", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        output: CLEAN_GIT_STATUS_OUTPUT,
      }) // status
      .mockResolvedValueOnce({ success: true }) // fetch
      .mockResolvedValueOnce({
        success: false,
        error: "pathspec 'feature/bootstrap' did not match any file",
      }) // switch
      .mockResolvedValueOnce({
        success: true,
        output: ["* main", "  remotes/origin/main"].join("\n"),
      }) // branch list (branch missing on local+remote)
      .mockResolvedValueOnce({ success: true }) // create branch
      .mockResolvedValueOnce({ success: true }); // pull (unused because no remote branch)
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_100001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "feature/bootstrap",
      },
    });

    expect(result.status).toBe("ready");
    expect(execute).toHaveBeenCalledWith("git", "git_branch_list", {});
    expect(execute).toHaveBeenCalledWith("git", "git_branch_create", {
      branch: "feature/bootstrap",
    });
  });

  it("skips git sync when the same run/repo/branch was recently bootstrapped", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        output: CLEAN_GIT_STATUS_OUTPUT,
      }) // first status
      .mockResolvedValueOnce({ success: true }) // first fetch
      .mockResolvedValueOnce({ success: true }) // first switch
      .mockResolvedValueOnce({ success: true }) // first pull
      .mockResolvedValueOnce({
        success: true,
        output: CLEAN_GIT_STATUS_OUTPUT,
      }); // second status
    const service = new WorkspaceBootstrapService({ execute }, 60_000);
    const request = {
      runId: "run_cachetest001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    } as const;

    const firstResult = await service.bootstrap(request);
    const secondResult = await service.bootstrap(request);

    expect(firstResult.status).toBe("ready");
    expect(secondResult.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(5);
    expect(execute).toHaveBeenNthCalledWith(1, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_fetch", {
      remote: "origin",
    });
    expect(execute).toHaveBeenNthCalledWith(3, "git", "git_branch_switch", {
      branch: "main",
    });
    expect(execute).toHaveBeenNthCalledWith(4, "git", "git_pull", {
      remote: "origin",
      branch: "main",
    });
    expect(execute).toHaveBeenNthCalledWith(5, "git", "git_status", {});
  });

  it("does not use a fresh sync cache when the workspace is no longer a git repository", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        output: CLEAN_GIT_STATUS_OUTPUT,
      }) // first status
      .mockResolvedValueOnce({ success: true }) // first fetch
      .mockResolvedValueOnce({ success: true }) // first switch
      .mockResolvedValueOnce({ success: true }) // first pull
      .mockResolvedValueOnce({
        success: false,
        error: "fatal: not a git repository",
      }) // second status
      .mockResolvedValueOnce({ success: true }) // clone after stale cache detected
      .mockResolvedValueOnce({ success: true }) // fetch after clone
      .mockResolvedValueOnce({ success: true }); // switch after clone
    const service = new WorkspaceBootstrapService({ execute }, 60_000);
    const request = {
      runId: "run_cacherevalidates001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    } as const;

    const firstResult = await service.bootstrap(request);
    const secondResult = await service.bootstrap(request);

    expect(firstResult.status).toBe("ready");
    expect(secondResult.status).toBe("ready");
    expect(secondResult.clonedDuringBootstrap).toBe(true);
    expect(execute).toHaveBeenNthCalledWith(5, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(6, "git", "git_clone", {
      url: "https://github.com/sourcegraph/shadowbox.git",
    });
  });

  it("coalesces concurrent bootstrap calls for the same run", async () => {
    let releaseStatusCheck: (() => void) | null = null;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatusCheck = resolve;
    });
    const execute = vi.fn(
      async (
        _plugin: string,
        action: string,
        _payload: Record<string, unknown>,
      ) => {
        if (action === "git_status") {
          await statusGate;
          return {
            success: true,
            output: CLEAN_GIT_STATUS_OUTPUT,
          };
        }
        return { success: true };
      },
    );
    const service = new WorkspaceBootstrapService({ execute }, 0);
    const request = {
      runId: "run_concurrentcollapse001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    } as const;

    const firstBootstrap = service.bootstrap(request);
    const secondBootstrap = service.bootstrap(request);
    await flushBootstrapQueue();
    expect(execute).toHaveBeenCalledTimes(1);

    releaseStatusCheck?.();
    const [firstResult, secondResult] = await Promise.all([
      firstBootstrap,
      secondBootstrap,
    ]);

    expect(firstResult.status).toBe("ready");
    expect(secondResult.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenNthCalledWith(1, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_fetch", {
      remote: "origin",
    });
    expect(execute).toHaveBeenNthCalledWith(3, "git", "git_branch_switch", {
      branch: "main",
    });
    expect(execute).toHaveBeenNthCalledWith(4, "git", "git_pull", {
      remote: "origin",
      branch: "main",
    });
  });

  it("serializes bootstrap calls when mode differs for the same workspace", async () => {
    let releaseStatusCheck: (() => void) | null = null;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatusCheck = resolve;
    });
    const execute = vi.fn(
      async (
        _plugin: string,
        action: string,
        _payload: Record<string, unknown>,
      ) => {
        if (action === "git_status") {
          await statusGate;
          return {
            success: true,
            output: CLEAN_GIT_STATUS_OUTPUT,
          };
        }
        return { success: true };
      },
    );
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const mutationBootstrap = service.bootstrap({
      runId: "run_modesplit001",
      mode: "mutation",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });
    const gitWriteBootstrap = service.bootstrap({
      runId: "run_modesplit001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    await flushBootstrapQueue();
    expect(execute).toHaveBeenCalledTimes(1);
    releaseStatusCheck?.();

    const [mutationResult, gitWriteResult] = await Promise.all([
      mutationBootstrap,
      gitWriteBootstrap,
    ]);
    expect(mutationResult.status).toBe("ready");
    expect(gitWriteResult.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(7);
    expect(execute).toHaveBeenNthCalledWith(1, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_fetch", {
      remote: "origin",
    });
    expect(execute).toHaveBeenNthCalledWith(3, "git", "git_branch_switch", {
      branch: "main",
    });
    expect(execute).toHaveBeenNthCalledWith(4, "git", "git_status", {});
    expect(execute).toHaveBeenNthCalledWith(5, "git", "git_fetch", {
      remote: "origin",
    });
    expect(execute).toHaveBeenNthCalledWith(6, "git", "git_branch_switch", {
      branch: "main",
    });
    expect(execute).toHaveBeenNthCalledWith(7, "git", "git_pull", {
      remote: "origin",
      branch: "main",
    });
  });

  it("serializes implicit-main and explicit-main bootstrap calls together", async () => {
    let releaseStatusCheck: (() => void) | null = null;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatusCheck = resolve;
    });
    const execute = vi.fn(
      async (
        _plugin: string,
        action: string,
        _payload: Record<string, unknown>,
      ) => {
        if (action === "git_status") {
          await statusGate;
          return {
            success: true,
            output: CLEAN_GIT_STATUS_OUTPUT,
          };
        }
        return { success: true };
      },
    );
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const explicitMain = service.bootstrap({
      runId: "run_implicitmain001",
      mode: "mutation",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });
    const implicitMain = service.bootstrap({
      runId: "run_implicitmain001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
      },
    });

    await flushBootstrapQueue();
    expect(execute).toHaveBeenCalledTimes(1);
    releaseStatusCheck?.();

    const [explicitResult, implicitResult] = await Promise.all([
      explicitMain,
      implicitMain,
    ]);
    expect(explicitResult.status).toBe("ready");
    expect(implicitResult.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it("coalesces duplicates while serializing mixed-mode workspace bootstrap", async () => {
    let releaseStatusCheck: (() => void) | null = null;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatusCheck = resolve;
    });
    const execute = vi.fn(
      async (
        _plugin: string,
        action: string,
        _payload: Record<string, unknown>,
      ) => {
        if (action === "git_status") {
          await statusGate;
          return {
            success: true,
            output: CLEAN_GIT_STATUS_OUTPUT,
          };
        }
        return { success: true };
      },
    );
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const mutationRequest = {
      runId: "run_mixedkey001",
      mode: "mutation",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    } as const;
    const gitWriteRequest = {
      runId: "run_mixedkey001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    } as const;

    const firstMutation = service.bootstrap(mutationRequest);
    const firstGitWrite = service.bootstrap(gitWriteRequest);
    const secondMutation = service.bootstrap(mutationRequest);

    await flushBootstrapQueue();
    expect(execute).toHaveBeenCalledTimes(1);
    releaseStatusCheck?.();

    const [mutationResultA, gitWriteResult, mutationResultB] =
      await Promise.all([firstMutation, firstGitWrite, secondMutation]);
    expect(mutationResultA.status).toBe("ready");
    expect(gitWriteResult.status).toBe("ready");
    expect(mutationResultB.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it("skips fetch and pull when the existing workspace has local changes", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({
        branch: "main",
        files: [
          {
            path: "README.md",
            status: "modified",
            additions: 1,
            deletions: 0,
            isStaged: false,
          },
        ],
        ahead: 0,
        behind: 0,
        repoIdentity: "github.com/sourcegraph/shadowbox",
        hasStaged: false,
        hasUnstaged: true,
        gitAvailable: true,
      }),
    });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_dirty001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("git", "git_status", {});
  });

  it("preserves the current branch for an initialized run workspace", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      success: true,
      output: JSON.stringify({
        branch: "feature/other",
        files: [],
        ahead: 1,
        behind: 0,
        repoIdentity: "github.com/sourcegraph/shadowbox",
        hasStaged: false,
        hasUnstaged: false,
        gitAvailable: true,
      }),
    });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_branchmismatch001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("git", "git_status", {});
  });

  it("fails closed on malformed git status payloads", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      success: true,
      output: "{not-json",
    });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_invalidstatus001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("sync-failed");
    expect(result.message).toContain("Invalid git status response");
  });

  it("fails closed on non-string malformed git status payloads", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      success: true,
      output: { branch: "main" },
    });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_invalidobjectstatus001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("sync-failed");
    expect(result.message).toContain("Invalid git status response");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not short-circuit ready when local changes belong to a different repo identity", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        output: JSON.stringify({
          branch: "main",
          files: [
            {
              path: "README.md",
              status: "modified",
              additions: 1,
              deletions: 0,
              isStaged: false,
            },
          ],
          ahead: 0,
          behind: 0,
          repoIdentity: "github.com/sourcegraph/other-repo",
          hasStaged: false,
          hasUnstaged: true,
          gitAvailable: true,
        }),
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true });
    const service = new WorkspaceBootstrapService({ execute }, 0);

    const result = await service.bootstrap({
      runId: "run_repomismatch001",
      mode: "git_write",
      repositoryContext: {
        owner: "sourcegraph",
        repo: "shadowbox",
        branch: "main",
      },
    });

    expect(result.status).toBe("ready");
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute).toHaveBeenNthCalledWith(2, "git", "git_fetch", {
      remote: "origin",
    });
  });
});

async function flushBootstrapQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
