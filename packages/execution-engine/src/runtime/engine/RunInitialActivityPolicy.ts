import { RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import type { CoreMessage } from "ai";
import type { RunEventRecorder } from "../events/index.js";
import type { Run } from "../run/index.js";
import { readLatestUserMessageId } from "./RunInputMessages.js";

export async function recordInitialTurnActivity(input: {
  run: Run;
  messages: CoreMessage[];
  prompt: string;
  runEventRecorder: RunEventRecorder;
}): Promise<void> {
  const clientMessageId = readLatestUserMessageId(input.messages);
  await input.runEventRecorder.recordMessageEmitted(
    "user",
    input.prompt,
    clientMessageId ? { clientMessageId } : undefined,
  );
  const phase =
    input.run.metadata.manifest?.mode === "plan"
      ? RUN_WORKFLOW_STEPS.PLANNING
      : RUN_WORKFLOW_STEPS.EXECUTION;
  await input.runEventRecorder.recordRunProgress(
    phase,
    "Thinking",
    "",
    "active",
  );
}
