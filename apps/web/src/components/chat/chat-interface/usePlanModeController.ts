import { useEffect, useRef, useState } from "react";
import type { Message } from "@ai-sdk/react";
import type { RunMode } from "@repo/shared-types";

const PLAN_MODE_RECOVERY_SENTINELS = [
  "I couldn't generate a valid structured plan for this turn",
  "Planning timed out before I could build safe executable tasks",
];

interface PlanModeControllerInput {
  runId: string;
  messages: Message[];
  mode: RunMode;
  isLoading: boolean;
  handoffPrompt?: string;
  append: (message: { role: "user"; content: string }) => Promise<void>;
  restoreInput: (input: string) => void;
  onModeChange?: (mode: RunMode) => void;
}

export function usePlanModeController(input: PlanModeControllerInput) {
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const lastRecoveryKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingPrompt || input.mode !== "build" || input.isLoading) return;

    const submitHandoff = async (): Promise<void> => {
      try {
        await input.append({ role: "user", content: pendingPrompt });
      } catch (error) {
        console.warn("[chat/interface] Failed to submit plan handoff", error);
        input.restoreInput(pendingPrompt);
      } finally {
        setPendingPrompt(null);
      }
    };
    void submitHandoff();
  }, [input, pendingPrompt]);

  useEffect(() => {
    if (input.mode !== "plan" || !input.onModeChange) return;
    const latestAssistant = [...input.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (!latestAssistant?.content) return;

    const recoveryKey = `${input.runId}:${latestAssistant.id}`;
    const isRecoverable = PLAN_MODE_RECOVERY_SENTINELS.some((sentinel) =>
      latestAssistant.content.includes(sentinel),
    );
    if (lastRecoveryKeyRef.current === recoveryKey || !isRecoverable) return;

    lastRecoveryKeyRef.current = recoveryKey;
    console.warn(
      `[chat/interface] Auto-switching runId=${input.runId} from plan to build after planner recovery output.`,
    );
    input.onModeChange("build");
  }, [input]);

  const usePlanInBuild = () => {
    const prompt = input.handoffPrompt?.trim();
    if (!prompt) return;
    setPendingPrompt(prompt);
    if (input.mode !== "build") input.onModeChange?.("build");
  };

  return {
    usePlanInBuild:
      input.handoffPrompt && (input.mode === "build" || input.onModeChange)
        ? usePlanInBuild
        : undefined,
  };
}
