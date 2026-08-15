import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { runSafeCommand } from "../security/SafeCommand";
import { LanguageToolService } from "./LanguageToolService";

vi.mock("../security/SafeCommand", () => ({
  runSafeCommand: vi.fn(),
}));

const WORKSPACE_ROOT = "/home/sandbox/checkouts/run-language";

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
    const command = findCommand("prettier");
    expect(command).toMatchObject({
      args: ["--write", "--", `${WORKSPACE_ROOT}/src/app.ts`],
      cwd: WORKSPACE_ROOT,
    });
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
