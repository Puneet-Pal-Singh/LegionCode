import type { ChatSubmitAttachments } from "../components/chat/chatImageAttachments";

declare const initialPromptSubmissionIdBrand: unique symbol;

export type InitialPromptSubmissionId = string & {
  readonly [initialPromptSubmissionIdBrand]: true;
};

export interface InitialPromptSubmission {
  id: InitialPromptSubmissionId;
  prompt: string;
  attachments?: ChatSubmitAttachments;
}

export function createInitialPromptSubmissionId(
  value: string,
): InitialPromptSubmissionId {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Initial prompt submission id cannot be empty");
  }
  return normalized as InitialPromptSubmissionId;
}
