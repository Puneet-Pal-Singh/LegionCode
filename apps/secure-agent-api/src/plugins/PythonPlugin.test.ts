import { describe, expect, it } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { PythonPlugin } from "./PythonPlugin";
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

function testExecutionContext(sandbox: SandboxMock, runId = "default"): PluginExecutionContext {
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

describe("PythonPlugin", () => {
  it("rejects unsafe requirement specifiers before execution", async () => {
    const plugin = new PythonPlugin();
    const sandbox = createSandboxMock([]);

    const result = await plugin.execute(asSandbox(sandbox), {
      code: "print('hello')",
      requirements: ["requests; rm -rf /"],
    }, undefined, testExecutionContext(sandbox));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid Python requirement/i);
    expect(sandbox.execCalls).toHaveLength(0);
  });

  it("retries dependency installation for managed environments", async () => {
    const plugin = new PythonPlugin();
    const sandbox = createSandboxMock([
      { exitCode: 0, stdout: "", stderr: "" },
      {
        exitCode: 1,
        stdout: "",
        stderr: "externally-managed-environment",
      },
      { exitCode: 0, stdout: "installed", stderr: "" },
      { exitCode: 0, stdout: "ok", stderr: "" },
    ]);

    const result = await plugin.execute(asSandbox(sandbox), {
      code: "print('ok')",
      requirements: ["requests"],
      runId: "run_py_1",
    }, undefined, testExecutionContext(sandbox, "run_py_1"));

    expect(result.success).toBe(true);
    expect(sandbox.execCalls).toHaveLength(4);
    expect(sandbox.execCalls[2]).toContain("--break-system-packages");
  });

  it("runs python file from run-scoped workspace using safe command args", async () => {
    const plugin = new PythonPlugin();
    const sandbox = createSandboxMock([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "42\n", stderr: "" },
    ]);

    const result = await plugin.execute(asSandbox(sandbox), {
      code: "print(42)",
      runId: "run_py_2",
    }, undefined, testExecutionContext(sandbox, "run_py_2"));

    expect(result.success).toBe(true);
    expect(sandbox.writeFileCalls[0]?.fileName).toBe(
      "/home/sandbox/checkouts/run_py_2/main.py",
    );
    expect(sandbox.execCalls[1]).toEqual(["python3", "main.py"]);
    expect(sandbox.execOptions[1]?.cwd).toBe("/home/sandbox/checkouts/run_py_2");
  });
});
