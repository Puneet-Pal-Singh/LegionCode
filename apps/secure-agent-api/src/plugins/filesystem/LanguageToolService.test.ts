import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { runSafeCommand } from "../security/SafeCommand";
import { LanguageToolService } from "./LanguageToolService";

vi.mock("../security/SafeCommand", () => ({
  runSafeCommand: vi.fn(),
}));

const WORKSPACE_ROOT = "/home/sandbox/runs/run-language";

describe("LanguageToolService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("formats supported files with fixed Prettier arguments", async () => {
    const sandbox = createSandbox(["const x=1\n", "const x = 1;\n"]);
    mockResolvedPathAndCommand({
      exitCode: 0,
      stdout: "src/app.ts 10ms\n",
      stderr: "",
    });

    const result = await new LanguageToolService().formatFile(
      createContext(sandbox),
      "src/app.ts",
    );

    expect(result).toMatchObject({
      success: true,
      metadata: { path: "src/app.ts", formatter: "prettier", changed: true },
      truncated: false,
    });
    const command = findCommand("pnpm");
    expect(command).toMatchObject({
      args: [
        "exec",
        "prettier",
        "--write",
        "--",
        `${WORKSPACE_ROOT}/src/app.ts`,
      ],
      cwd: WORKSPACE_ROOT,
    });
  });

  it("treats TypeScript exit code two as diagnostic output", async () => {
    const sandbox = createSandbox([]);
    mockResolvedPathAndCommand({
      exitCode: 2,
      stdout: [
        "src/a.ts(1,1): error TS2322: Type mismatch",
        "src/b.ts(2,2): error TS2304: Missing name",
      ].join("\n"),
      stderr: "",
    });

    const result = await new LanguageToolService().diagnostics(
      createContext(sandbox),
      "src/app.ts",
    );

    expect(result).toMatchObject({
      success: true,
      metadata: { languageService: "typescript", diagnosticCount: 2 },
      truncated: false,
    });
  });

  it("caps broad diagnostic output", async () => {
    const sandbox = createSandbox([]);
    mockResolvedPathAndCommand({
      exitCode: 2,
      stdout: "x".repeat(30_000),
      stderr: "",
    });

    const result = await new LanguageToolService().diagnostics(
      createContext(sandbox),
      "src/app.ts",
    );

    expect(String(result.output)).toContain("[output truncated]");
    expect(String(result.output).length).toBeLessThan(24_100);
    expect(result.truncated).toBe(true);
  });

  it("rejects unsupported extensions before command execution", async () => {
    const sandbox = createSandbox([]);

    await expect(
      new LanguageToolService().diagnostics(
        createContext(sandbox),
        "image.png",
      ),
    ).rejects.toThrow(/does not support/i);
    expect(runSafeCommand).not.toHaveBeenCalled();
  });

  it("rejects resolved formatter paths outside the workspace", async () => {
    const sandbox = createSandbox([]);
    vi.mocked(runSafeCommand).mockResolvedValue({
      exitCode: 0,
      stdout: "/etc/app.ts\n",
      stderr: "",
    });

    await expect(
      new LanguageToolService().formatFile(
        createContext(sandbox),
        "linked/app.ts",
      ),
    ).rejects.toThrow(/escapes workspace root/i);
  });
});

function createContext(sandbox: Sandbox) {
  return {
    sandbox,
    workspaceRoot: WORKSPACE_ROOT,
    toolboxContext: {},
    runId: "run-language",
  };
}

function createSandbox(readContents: string[]): Sandbox {
  const queue = [...readContents];
  return {
    readFile: vi.fn(async () => ({
      success: true,
      content: queue.shift() ?? "",
    })),
  } as unknown as Sandbox;
}

function mockResolvedPathAndCommand(commandResult: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): void {
  vi.mocked(runSafeCommand).mockImplementation(async (_sandbox, spec) => {
    if (spec.command === "realpath") {
      return {
        exitCode: 0,
        stdout: `${spec.args?.at(-1) ?? WORKSPACE_ROOT}\n`,
        stderr: "",
      };
    }
    return commandResult;
  });
}

function findCommand(command: string) {
  return vi
    .mocked(runSafeCommand)
    .mock.calls.find(([, spec]) => spec.command === command)?.[1];
}
