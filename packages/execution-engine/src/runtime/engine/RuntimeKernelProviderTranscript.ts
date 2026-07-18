import type { TranscriptPart } from "@repo/platform-protocol";
import { RuntimeKernelError } from "@repo/runtime-kernel";
import { projectExplicitFinalText } from "./FinalPartValidator.js";
import { finalizeTranscriptParts } from "../llm/TranscriptPartNormalizer.js";

export interface RuntimeKernelTerminalTranscript {
  readonly text: string;
  readonly parts: readonly TranscriptPart[];
}

/**
 * Owns the provider transcript evidence retained by the native runtime adapter.
 * A kernel turn cannot complete unless the provider's terminal response can be
 * promoted to an explicit typed final part.
 */
export class RuntimeKernelProviderTranscript {
  private terminal: RuntimeKernelTerminalTranscript | null = null;

  complete(parts: readonly TranscriptPart[]): RuntimeKernelTerminalTranscript {
    const finalizedParts = finalizeTranscriptParts(parts);
    const text = projectExplicitFinalText(finalizedParts);
    if (!text) {
      throw new RuntimeKernelError(
        "model_final_missing",
        "The model stopped without returning a final answer.",
      );
    }

    this.terminal = { text, parts: finalizedParts };
    return this.terminal;
  }

  readFinalParts(): TranscriptPart[] {
    return this.terminal ? [...this.terminal.parts] : [];
  }
}
