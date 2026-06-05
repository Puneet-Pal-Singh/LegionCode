import { describe, expect, it } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { BashPlugin } from "../BashPlugin";
import { NodePlugin } from "../NodePlugin";
import { FileSystemPlugin } from "../FileSystemPlugin";
import { GitPlugin } from "../GitPlugin";
import { BashTool } from "../../schemas/bash";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface SandboxMock {
  execCalls: string[];
  exec: (command: string) => Promise<ExecResult>;
  writeFile: (fileName: string, content: string) => Promise<void>;
}

function createSandboxMock(): SandboxMock {
  const execCalls: string[] = [];
  return {
    execCalls,
    async exec(command: string): Promise<ExecResult> {
      execCalls.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile(): Promise<void> {
      return;
    },
  };
}

function createSandboxMockWithResponder(
  responder: (command: string, index: number) => ExecResult,
): SandboxMock {
  const execCalls: string[] = [];
  return {
    execCalls,
    async exec(command: string): Promise<ExecResult> {
      execCalls.push(command);
      return responder(command, execCalls.length - 1);
    },
    async writeFile(): Promise<void> {
      return;
    },
  };
}

function asSandbox(mock: SandboxMock): Sandbox {
  return mock as unknown as Sandbox;
}

describe("secure-agent-api plugin hardening", () => {
  it("rejects command injection tokens in node command", async () => {
    const plugin = new NodePlugin();
    const sandbox = createSandboxMock();

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-1",
      command: "node; rm -rf /",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsafe shell token detected in command/i);
    expect(sandbox.execCalls).toHaveLength(1);
  });

  it("rejects command injection tokens in node args", async () => {
    const plugin = new NodePlugin();
    const sandbox = createSandboxMock();

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-2",
      command: "node",
      args: ["-e", "console.log('ok'); cat /etc/passwd"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsafe shell token detected in args/i);
    expect(sandbox.execCalls).toHaveLength(1);
  });

  it("rejects dangerous bash command patterns", async () => {
    const plugin = new BashPlugin();
    const sandbox = createSandboxMock();

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-bash",
      command: "echo ok | bash",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Dangerous bash command pattern detected/i);
  });

  it("allows concrete git shell commands", async () => {
    const plugin = new BashPlugin();
    const sandbox = createSandboxMock();

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-bash-git",
      command: "pwd && git status",
    });

    expect(result.success).toBe(true);
    expect(sandbox.execCalls).toHaveLength(2);
  });

  it("allows safe shell redirection patterns used by read-only grep flows", async () => {
    const plugin = new BashPlugin();
    const sandbox = createSandboxMock();

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-bash-redirection",
      command:
        'rg -n "newsletter" supabase/migrations/ 2>/dev/null || echo "not found"',
    });

    expect(result.success).toBe(true);
    expect(sandbox.execCalls).toHaveLength(2);
  });

  it("adds a corepack fallback when running pnpm shell commands", async () => {
    const plugin = new BashPlugin();
    const sandbox = createSandboxMockWithResponder((command, index) => {
      if (index === 0) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (!command.includes("command -v corepack")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "missing pnpm/corepack fallback wrapper",
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-bash-pnpm",
      command: "pnpm run test",
    });

    expect(result.success).toBe(true);
    expect(sandbox.execCalls).toHaveLength(2);
    expect(sandbox.execCalls[1]).toContain(
      'export PATH="$PATH:/usr/local/bin:/usr/bin:/bin:/home/sandbox/.local/share/pnpm"; if command -v pnpm',
    );
    expect(sandbox.execCalls[1]).toContain("command -v pnpm");
    expect(sandbox.execCalls[1]).toContain("command -v corepack");
    expect(sandbox.execCalls[1]).toContain("corepack pnpm run test");
  });

  it("falls back to npm run when pnpm and corepack are unavailable", async () => {
    const plugin = new BashPlugin();
    const sandbox = createSandboxMockWithResponder((command, index) => {
      if (index === 0) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (!command.includes("else npm run test;")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "missing npm fallback wrapper",
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-bash-pnpm-npm-fallback",
      command: "pnpm run test",
    });

    expect(result.success).toBe(true);
    expect(sandbox.execCalls).toHaveLength(2);
    expect(sandbox.execCalls[1]).toContain("command -v pnpm");
    expect(sandbox.execCalls[1]).toContain("command -v corepack");
    expect(sandbox.execCalls[1]).toContain("else npm run test;");
  });

  it("surfaces a clear fallback error for unsupported pnpm subcommands", async () => {
    const plugin = new BashPlugin();
    const sandbox = createSandboxMockWithResponder((command, index) => {
      if (index === 0) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (
        !command.includes(
          "pnpm is unavailable in this runtime and no npm fallback mapping exists for: pnpm add lodash",
        )
      ) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "missing unsupported-subcommand fallback message",
        };
      }
      return {
        exitCode: 127,
        stdout: "",
        stderr:
          "pnpm is unavailable in this runtime and no npm fallback mapping exists for: pnpm add lodash",
      };
    });

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-bash-pnpm-unsupported",
      command: "pnpm add lodash",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      "pnpm is unavailable in this runtime and no npm fallback mapping exists for: pnpm add lodash",
    );
    expect(sandbox.execCalls).toHaveLength(2);
  });

  it("quotes unsupported pnpm fallback messages without shell expansion", async () => {
    const plugin = new BashPlugin();
    const sandbox = createSandboxMockWithResponder((command, index) => {
      if (index === 0) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      return {
        exitCode: 127,
        stdout: "",
        stderr: "",
      };
    });

    await plugin.execute(asSandbox(sandbox), {
      action: "run",
      runId: "run-safe-bash-pnpm-quoted-fallback",
      command: "pnpm unsupported $TOKEN",
    });

    expect(sandbox.execCalls[1]).toContain("printf");
    expect(sandbox.execCalls[1]).toContain("pnpm unsupported $TOKEN");
    expect(sandbox.execCalls[1]).not.toContain(
      'echo "pnpm is unavailable in this runtime and no npm fallback mapping exists for: pnpm unsupported $TOKEN"',
    );
  });

  it("registers the bash tool with the canonical runtime name", () => {
    expect(BashTool.name).toBe("bash");
  });

  it("rejects filesystem traversal and absolute paths", async () => {
    const plugin = new FileSystemPlugin();
    const sandbox = createSandboxMock();

    const traversal = await plugin.execute(asSandbox(sandbox), {
      action: "read_file",
      runId: "run-safe-3",
      path: "../../etc/passwd",
    });
    expect(traversal.success).toBe(false);
    expect(traversal.error).toMatch(/traversal|Access Denied/i);

    const absolute = await plugin.execute(asSandbox(sandbox), {
      action: "read_file",
      runId: "run-safe-3",
      path: "/etc/passwd",
    });
    expect(absolute.success).toBe(false);
    expect(absolute.error).toMatch(/absolute paths are not allowed/i);
  });

  it("returns read windows with line metadata", async () => {
    const plugin = new FileSystemPlugin();
    const sandbox = createSandboxMockWithResponder((command) => {
      if (command.includes("'file'")) {
        return { exitCode: 0, stdout: "text/plain\n", stderr: "" };
      }
      if (command.includes("'awk'")) {
        return { exitCode: 0, stdout: "line two\nline three\n", stderr: "" };
      }
      if (command.includes("'wc'")) {
        return {
          exitCode: 0,
          stdout: "4 /home/sandbox/runs/run-safe-read/a.txt\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "read_file",
      runId: "run-safe-read",
      path: "a.txt",
      offset: 1,
      limit: 2,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("line two\nline three\n");
    expect(result.metadata).toMatchObject({
      offset: 1,
      limit: 2,
      returnedLines: 2,
      totalLines: 4,
    });
    expect(sandbox.execCalls.some((command) => command.includes("'stat'"))).toBe(
      false,
    );
    expect(result.truncated).toBe(true);
  });

  it("returns an empty successful read window beyond EOF", async () => {
    const plugin = new FileSystemPlugin();
    const sandbox = createSandboxMockWithResponder((command) => {
      if (command.includes("'file'")) {
        return { exitCode: 0, stdout: "text/plain\n", stderr: "" };
      }
      if (command.includes("'awk'")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("'wc'")) {
        return {
          exitCode: 0,
          stdout: "3 /home/sandbox/runs/run-safe-empty/a.txt\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "read_file",
      runId: "run-safe-empty",
      path: "a.txt",
      offset: 10,
      limit: 2,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("");
    expect(result.metadata).toMatchObject({
      returnedLines: 0,
      totalLines: 3,
    });
  });

  it("routes invalid grep regex errors through filesystem metadata", async () => {
    const plugin = new FileSystemPlugin();
    const sandbox = createSandboxMockWithResponder((command) => {
      if (command.includes("'rg'")) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "regex parse error: unclosed character class",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "grep",
      runId: "run-safe-grep",
      pattern: "[",
      path: ".",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid grep regex/);
    expect(result.metadata).toMatchObject({ reason: "invalid_regex" });
    expect(result.truncated).toBe(false);
  });

  it("rejects traversal in fast glob paths", async () => {
    const plugin = new FileSystemPlugin();
    const sandbox = createSandboxMock();

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "glob",
      runId: "run-safe-glob",
      pattern: "**/*.ts",
      path: "../outside",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/traversal|Access Denied/i);
  });

  it("returns an empty successful result for fast glob misses", async () => {
    const plugin = new FileSystemPlugin();
    const sandbox = createSandboxMockWithResponder((command) => {
      if (command.includes("'rg'")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "glob",
      runId: "run-safe-glob-empty",
      pattern: "**/*.not-found",
      path: ".",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("");
    expect(result.metadata).toMatchObject({
      paths: [],
      total: 0,
      returned: 0,
    });
    expect(result.truncated).toBe(false);
  });

  it("validates git auth token format", async () => {
    const plugin = new GitPlugin();
    const sandbox = createSandboxMock();

    const invalidToken = await plugin.execute(asSandbox(sandbox), {
      action: "git_config",
      runId: "run-safe-4",
      token: "bad\ntoken",
    });
    expect(invalidToken.success).toBe(false);
    expect(invalidToken.error).toMatch(/Invalid token format/i);

    const validToken = await plugin.execute(asSandbox(sandbox), {
      action: "git_config",
      runId: "run-safe-4",
      token: "ghp_validToken123",
    });
    expect(validToken.success).toBe(true);
    expect(validToken.output).toBe(
      "Token validated for authenticated git actions",
    );
  });

  it("fails git commits when the workspace author is not configured", async () => {
    const plugin = new GitPlugin();
    const sandbox = createSandboxMock();

    const result = await plugin.execute(asSandbox(sandbox), {
      action: "git_commit",
      runId: "run-safe-5",
      message: "feat: test commit",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/git commit author is not configured/i);
  });
});
