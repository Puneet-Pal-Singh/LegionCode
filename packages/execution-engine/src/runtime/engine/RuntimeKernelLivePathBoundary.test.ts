import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const BRAIN_RUN_HANDLER = join(
  REPO_ROOT,
  "apps/brain/src/runtime/RunEngineRequestHandler.ts",
);
const ENGINE_BARREL = join(
  REPO_ROOT,
  "packages/execution-engine/src/runtime/engine/index.ts",
);
const NATIVE_RUNNER = join(
  REPO_ROOT,
  "packages/execution-engine/src/runtime/engine/RuntimeKernelNativeRunner.ts",
);

describe("RuntimeKernel live path boundary", () => {
  it("keeps Brain execution owned by the native RuntimeKernel runner", () => {
    const source = readFileSync(BRAIN_RUN_HANDLER, "utf8");

    expect(source).toContain("new RuntimeKernelNativeRunner");
    expect(source).toContain("new RunEngineKernelLifecycleEventStore");
    expect(source).toMatch(/lifecycleEvents:\s*kernelLifecycleEvents/);
    expect(source).not.toContain("new RunEngine(");
    expect(source).not.toContain("executeRunEngineThroughRuntimeKernel");
    expect(source).not.toMatch(
      /const\s+executionResponse\s*=\s*await\s+runEngine\.execute\(/,
    );
  });

  it("does not expose the legacy RunEngine kernel adapter from runtime barrels", () => {
    const source = readFileSync(ENGINE_BARREL, "utf8");

    expect(source).not.toMatch(/\bRunEngine,\s*$/m);
    expect(source).not.toContain("type IRunEngine");
    expect(source).not.toContain("executeRunEngineThroughRuntimeKernel");
    expect(source).not.toContain("RunEngineKernelAdapterInput");
  });

  it("keeps native kernel execution wired to run reset, status, and cancel settlement", () => {
    const source = readFileSync(NATIVE_RUNNER, "utf8");

    expect(source).toContain("resetRecyclableRun");
    expect(source).toContain("RunStateMachine.isTerminalState");
    expect(source).toContain("recordRunStatusChanged");
    expect(source).toContain("runWithNativeCancellationPolling");
    expect(source).toContain("NativeRunCancelledError");
  });

  it("keeps native model steps visible and classified by current turn intent", () => {
    const source = readFileSync(NATIVE_RUNNER, "utf8");

    expect(source).toContain("classifyCurrentTurnIntent");
    expect(source).toContain("requiresMutationForIntent");
    expect(source).toContain("recordModelStepStarted");
    expect(source).toContain("recordModelStepCompleted");
    expect(source).toContain(
      'recordRunProgress(\n      RUN_WORKFLOW_STEPS.EXECUTION,\n      "Thinking"',
    );
    expect(source).toContain(
      "runWithNativeCancellationPolling(\n      executeAgenticLoopTool",
    );
    expect(source).not.toContain("requiresMutation: true,");
  });
});
