import { describe, expect, it } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { RustPlugin } from "./RustPlugin";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SandboxMock {
  execCalls: string[];
  execOptions: Array<{ cwd?: string; env?: Record<string, string | undefined> }>;
  writeFileCalls: Array<{ fileName: string; content: string }>;
  exec: (
    command: string,
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ) => Promise<ExecResult>;
  writeFile: (fileName: string, content: string) => Promise<void>;
}

function createSandboxMock(responses: ExecResult[]): SandboxMock {
  const execCalls: string[] = [];
  const execOptions: Array<{
    cwd?: string;
    env?: Record<string, string | undefined>;
  }> = [];
  const writeFileCalls: Array<{ fileName: string; content: string }> = [];

  return {
    execCalls,
    execOptions,
    writeFileCalls,
    async exec(
      command: string,
      options?: { cwd?: string; env?: Record<string, string | undefined> },
    ): Promise<ExecResult> {
      execCalls.push(command);
      execOptions.push(options ?? {});
      return (
        responses.shift() ?? {
          exitCode: 0,
          stdout: "",
          stderr: "",
        }
      );
    },
    async writeFile(fileName: string, content: string): Promise<void> {
      writeFileCalls.push({ fileName, content });
    },
  };
}

function asSandbox(mock: SandboxMock): Sandbox {
  return mock as unknown as Sandbox;
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
    } as { code: string });

    expect(result.success).toBe(true);
    expect(sandbox.writeFileCalls[0]?.fileName).toBe(
      "/home/sandbox/runs/run_rust_1/main.rs",
    );
    expect(sandbox.execCalls[1]).toBe("'rustc' 'main.rs' '-o' 'main_bin'");
    expect(sandbox.execOptions[1]?.cwd).toBe(
      "/home/sandbox/runs/run_rust_1",
    );
    expect(sandbox.execCalls[2]).toBe("'./main_bin'");
    expect(sandbox.execOptions[2]?.cwd).toBe(
      "/home/sandbox/runs/run_rust_1",
    );
  });
});
