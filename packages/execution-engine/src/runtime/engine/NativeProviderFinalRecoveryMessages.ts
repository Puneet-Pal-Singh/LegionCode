import type { CoreMessage } from "ai";

const FINAL_RESPONSE_CORRECTION = [
  "Return the final user-facing answer now.",
  "Output only the answer, with no analysis, planning, preamble, or description of the user.",
  "If the original request asks for an exact short reply, output exactly that reply.",
].join(" ");

export function buildNativeProviderMessages(
  messages: readonly CoreMessage[],
  finalRecoveryAttempt: number,
): CoreMessage[] {
  if (finalRecoveryAttempt === 0) {
    return [...messages];
  }
  return [
    ...messages,
    {
      role: "user",
      content: FINAL_RESPONSE_CORRECTION,
    },
  ];
}
