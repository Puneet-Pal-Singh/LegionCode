import type { RunId } from "@repo/platform-protocol";
import { describe, expect, it } from "vitest";

interface GitCommandExecutionFixture {
  readonly runId: RunId;
  readonly cwd: string;
  readonly args: readonly string[];
}

interface GitCommandResultFixture {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GitCommandExecutorPort {
  execute(input: GitCommandExecutionFixture): Promise<GitCommandResultFixture>;
}

interface GitServiceContract {
  getStatus(input: {
    readonly runId: string;
    readonly workspaceRoot: string;
  }): Promise<{ readonly isDirty: boolean }>;
}

export function registerGitServiceConformance(
  implementation: string,
  createService: (executor: GitCommandExecutorPort) => unknown,
): void {
  describe(`${implementation} GitService conformance`, () => {
    it("scopes status commands to the declared run and workspace", async () => {
      const executor = new ConformanceGitExecutor({
        exitCode: 0,
        stdout: "# branch.head dev\0? src/new.ts\0",
        stderr: "",
      });
      const service = createService(executor) as GitServiceContract;
      const status = await service.getStatus({
        runId: "run_conformance",
        workspaceRoot: "/workspace/run_conformance",
      });

      expect(status.isDirty).toBe(true);
      expect(executor.calls[0]).toMatchObject({
        runId: "run_conformance",
        cwd: "/workspace/run_conformance",
      });
    });

    it("fails fast on unscoped input and reports command failures as typed errors", async () => {
      const executor = new ConformanceGitExecutor({
        exitCode: 128,
        stdout: "",
        stderr: "status failed",
      });
      const service = createService(executor) as GitServiceContract;

      await expect(
        service.getStatus({ runId: "run_conformance", workspaceRoot: "" }),
      ).rejects.toMatchObject({ code: "invalid_git_input" });
      await expect(
        service.getStatus({
          runId: "run_conformance",
          workspaceRoot: "/workspace/run_conformance",
        }),
      ).rejects.toMatchObject({ code: "git_command_failed" });
    });
  });
}

class ConformanceGitExecutor implements GitCommandExecutorPort {
  readonly calls: GitCommandExecutionFixture[] = [];

  constructor(private readonly result: GitCommandResultFixture) {}

  async execute(input: GitCommandExecutionFixture): Promise<GitCommandResultFixture> {
    this.calls.push(input);
    return this.result;
  }
}
