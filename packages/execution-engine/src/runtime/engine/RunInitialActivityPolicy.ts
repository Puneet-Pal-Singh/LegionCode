import { RUN_WORKFLOW_STEPS } from "@repo/shared-types";
import type { CoreMessage } from "ai";
import type { RunEventRecorder } from "../events/index.js";
import type { Run } from "../run/index.js";

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

function readLatestUserMessageId(messages: CoreMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    const id = (message as CoreMessage & { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  }
  return null;
}
