import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@cloudflare/sandbox";
import { runSafeCommand } from "../security/SafeCommand";
import { WorkspaceEditService } from "./WorkspaceEditService";

vi.mock("../security/SafeCommand", () => ({
  runSafeCommand: vi.fn(),
}));

const WORKSPACE_ROOT = "/home/sandbox/runs/run-edit";

describe("WorkspaceEditService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(runSafeCommand).mockImplementation(async (_sandbox, spec) => ({
      exitCode: 0,
      stdout:
        spec.command === "realpath"
          ? `${spec.args?.at(-1) ?? WORKSPACE_ROOT}\n`
          : "",
      stderr: "",
    }));
  });

  it("atomically replaces one exact match", async () => {
    const sandbox = createSandbox({ "src/app.ts": "const value = 1;\n" });
    const service = new WorkspaceEditService();

    const result = await service.edit(createContext(sandbox), {
      path: "src/app.ts",
      oldText: "value = 1",
      newText: "value = 2",
    });

    expect(result).toMatchObject({
      success: true,
      metadata: { path: "src/app.ts", replacementCount: 1 },
      truncated: false,
    });
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/src\/\.shadowbox-edit-.+\.tmp$/),
      "const value = 2;\n",
    );
    expect(findCommand("mv")?.args?.at(-1)).toBe(
      `${WORKSPACE_ROOT}/src/app.ts`,
    );
  });

  it("rejects resolved paths outside the workspace", async () => {
    vi.mocked(runSafeCommand).mockResolvedValue({
      exitCode: 0,
      stdout: "/etc/passwd\n",
      stderr: "",
    });
    const sandbox = createSandbox({});

    await expect(
      new WorkspaceEditService().write(createContext(sandbox), {
        path: "linked/passwd",
        content: "blocked",
      }),
    ).rejects.toThrow(/escapes workspace root/i);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("rejects stale hash preconditions before writing", async () => {
    const sandbox = createSandbox({ "src/app.ts": "current\n" });

    await expect(
      new WorkspaceEditService().edit(createContext(sandbox), {
        path: "src/app.ts",
        oldText: "current",
        newText: "next",
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/Edit conflict/);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("rejects ambiguous single replacements", async () => {
    const sandbox = createSandbox({ "src/app.ts": "same same" });

    await expect(
      new WorkspaceEditService().edit(createContext(sandbox), {
        path: "src/app.ts",
        oldText: "same",
        newText: "next",
      }),
    ).rejects.toThrow(/ambiguous/i);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("rolls back prior files when a later multi-edit move fails", async () => {
    const sandbox = createSandbox({
      "src/a.ts": "old-a",
      "src/b.ts": "old-b",
    });
    let moveCount = 0;
    vi.mocked(runSafeCommand).mockImplementation(async (_sandbox, spec) => {
      if (spec.command === "realpath") {
        return {
          exitCode: 0,
          stdout: `${spec.args?.at(-1) ?? WORKSPACE_ROOT}\n`,
          stderr: "",
        };
      }
      if (spec.command === "mv" && ++moveCount === 2) {
        return { exitCode: 1, stdout: "", stderr: "move failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      new WorkspaceEditService().multiEdit(createContext(sandbox), [
        { path: "src/a.ts", oldText: "old-a", newText: "new-a" },
        { path: "src/b.ts", oldText: "old-b", newText: "new-b" },
      ]),
    ).rejects.toThrow(/move failed/);
    expect(sandbox.writeFile).toHaveBeenLastCalledWith(
      expect.stringMatching(/src\/\.shadowbox-edit-.+\.tmp$/),
      "old-a",
    );
    expect(moveCount).toBe(3);
  });
});

function createContext(sandbox: Sandbox) {
  return {
    sandbox,
    workspaceRoot: WORKSPACE_ROOT,
    toolboxContext: {},
    runId: "run-edit",
  };
}

function createSandbox(files: Record<string, string>): Sandbox {
  return {
    readFile: vi.fn(async (targetPath: string) => {
      const relativePath = targetPath.replace(`${WORKSPACE_ROOT}/`, "");
      const content = files[relativePath];
      return content === undefined
        ? { success: false, content: "" }
        : { success: true, content };
    }),
    writeFile: vi.fn(async () => undefined),
  } as unknown as Sandbox;
}

function findCommand(command: string) {
  return vi
    .mocked(runSafeCommand)
    .mock.calls.find(([, spec]) => spec.command === command)?.[1];
}
