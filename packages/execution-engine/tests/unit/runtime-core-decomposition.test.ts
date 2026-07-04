import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUN_ENGINE_MAX_LINES = 1060;
const TASK_SCHEDULER_MAX_LINES = 420;

describe("runtime core decomposition guard", () => {
  it("keeps orchestration shell slim and collaborator-driven", () => {
    const runEnginePath = join(process.cwd(), "src/runtime/engine/RunEngine.ts");
    const taskSchedulerPath = join(
      process.cwd(),
      "src/runtime/orchestration/TaskScheduler.ts",
    );

    const runEngineSource = readFileSync(runEnginePath, "utf8");
    const taskSchedulerSource = readFileSync(taskSchedulerPath, "utf8");

    const runEngineLineCount = runEngineSource.split("\n").length;
    const taskSchedulerLineCount = taskSchedulerSource.split("\n").length;

    expect(runEngineLineCount).toBeLessThanOrEqual(RUN_ENGINE_MAX_LINES);
    expect(taskSchedulerLineCount).toBeLessThanOrEqual(TASK_SCHEDULER_MAX_LINES);

    expect(runEngineSource).toContain('from "./RunAgenticLoopPolicy.js"');
    expect(runEngineSource).toContain('from "./RunOutputRedactor.js"');
    expect(runEngineSource).toContain('from "./RunStatusPolicy.js"');
    expect(runEngineSource).not.toContain('from "./ConversationPolicy.js"');

    expect(runEngineSource).not.toContain("private buildConversationalSystemPrompt(");
    expect(runEngineSource).not.toContain("private sanitizeUserFacingOutput(");
    expect(runEngineSource).not.toContain("private transitionRunToCompleted(");
    expect(runEngineSource).not.toContain("private determineRunStatusFromTasks(");

    expect(taskSchedulerSource).toContain('from "./RetryClassifier.js"');
    expect(taskSchedulerSource).not.toContain("isLikelyTransientFailure");
  });
});
