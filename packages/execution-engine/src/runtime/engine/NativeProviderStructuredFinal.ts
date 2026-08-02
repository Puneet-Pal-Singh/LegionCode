import type { TranscriptPart } from "@repo/platform-protocol";
import { z } from "zod";

export const NativeProviderFinalAnswerSchema = z.object({
  finalAnswer: z.string().trim().min(1).max(50_000),
});

export function buildNativeProviderStructuredFinal(input: {
  runId: string;
  turnId: string;
  finalAnswer: string;
  sequence: number;
  createdAt?: string;
}): TranscriptPart {
  return {
    id: `${input.turnId}:structured-final:${input.sequence}`,
    schemaVersion: 1,
    runId: input.runId,
    turnId: input.turnId,
    sequence: input.sequence,
    createdAt: input.createdAt ?? new Date().toISOString(),
    type: "final",
    visibility: "visible",
    text: input.finalAnswer,
  };
}
