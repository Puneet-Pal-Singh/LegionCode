import type { TranscriptPart } from "@repo/platform-protocol";

export type ExplicitFinalTranscriptPart = Extract<
  TranscriptPart,
  { type: "final" }
>;

export function isExplicitFinalTranscriptPart(
  part: TranscriptPart,
): part is ExplicitFinalTranscriptPart {
  return (
    part.type === "final" &&
    part.visibility === "visible" &&
    part.text.trim().length > 0
  );
}

export function projectExplicitFinalText(
  parts: readonly TranscriptPart[],
): string {
  return parts
    .filter(isExplicitFinalTranscriptPart)
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}
