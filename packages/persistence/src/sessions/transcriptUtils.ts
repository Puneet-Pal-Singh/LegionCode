import type {
  AppendExistingTranscriptMessageInput,
  TranscriptMessageRecord,
} from "./types.js";

export function assertHasParts(parts: AppendExistingTranscriptMessageInput["parts"]): void {
  if (parts.length === 0) {
    throw new Error("Transcript message must contain at least one part");
  }
}

export function firstSequence(message: TranscriptMessageRecord): number {
  return Math.min(...message.parts.map((part) => part.sessionSequence));
}

export function lastSequence(message: TranscriptMessageRecord): number {
  return Math.max(...message.parts.map((part) => part.sessionSequence));
}
