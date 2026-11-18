import { describe, expect, it } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { RustPlugin } from "./RustPlugin";
import type { PluginExecutionContext } from "../interfaces/types";
import type { NativeCommandCapability } from "../toolbox/contracts/OwnedSandboxCommand";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SandboxMock {
  execCalls: string[][];
  nativeCommands: NativeCommandCapability;
  execOptions: Array<{ cwd?: string; env?: Record<string, string | undefined> }>;
  writeFileCalls: Array<{ fileName: string; content: string }>;
  exec: (
    command: string,
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ) => Promise<ExecResult>;
  writeFile: (fileName: string, content: string) => Promise<void>;
}

function createSandboxMock(responses: ExecResult[]): SandboxMock {
  const execCalls: string[][] = [];
  const execOptions: Array<{
    cwd?: string;
    env?: Record<string, string | undefined>;
  }> = [];
  const writeFileCalls: Array<{ fileName: string; content: string }> = [];

  return {
    execCalls,
    execOptions,
    writeFileCalls,
    async exec(): Promise<ExecResult> { throw new Error("Unowned SDK execution is forbidden"); },
    nativeCommands: {
      async execute(spec) {
        execCalls.push(spec.argv);
        execOptions.push({ cwd: spec.cwd, env: spec.env });
        return responses.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
      },
      async prepareWorkspace() { throw new Error("Not a provisioning fixture"); },
      async stop() { return true; },
      async awaitClosure() { return true; },
    },
    async writeFile(fileName: string, content: string): Promise<void> {
      writeFileCalls.push({ fileName, content });
    },
  };
}

function asSandbox(mock: SandboxMock): Sandbox {
  return mock as unknown as Sandbox;
}

function testExecutionContext(sandbox: SandboxMock, runId: string): PluginExecutionContext {
  return {
    nativeCommands: sandbox.nativeCommands,
    workspaceScope: {
      runId,
      workspaceId: "workspace-test",
      threadId: "thread-test",
      turnId: "turn-test",
      runAttemptId: "attempt-test",
      root: `/home/sandbox/checkouts/${runId}`,
    },
  };
}

describe("RustPlugin", () => {
  it("runs compile and execution steps from the run-scoped workspace", async () => {
    const plugin = new RustPlugin();
    const sandbox = createSandboxMock([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "hello\n", stderr: "" },
    ]);

    const result = await plugin.execute(asSandbox(sandbox), {
      code: 'fn main() { println!("hello"); }',
      __toolbox: {
        runId: "run_rust_1",
        callId: "task-rust-1",
        toolName: "rust.execute",
      },
    } as { code: string }, undefined, testExecutionContext(sandbox, "run_rust_1"));

    expect(result.success).toBe(true);
    expect(sandbox.writeFileCalls[0]?.fileName).toBe(
      "/home/sandbox/checkouts/run_rust_1/main.rs",
    );
    expect(sandbox.execCalls[1]).toEqual(["rustc", "main.rs", "-o", "main_bin"]);
    expect(sandbox.execOptions[1]?.cwd).toBe(
      "/home/sandbox/checkouts/run_rust_1",
    );
    expect(sandbox.execCalls[2]).toEqual(["./main_bin"]);
    expect(sandbox.execOptions[2]?.cwd).toBe(
      "/home/sandbox/checkouts/run_rust_1",
    );
  });
});
