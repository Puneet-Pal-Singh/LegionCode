import type { ChatImageAttachment } from "../chat/chatImageAttachments";

/** An unsent UI draft transferred only after an explicit project choice. */
export interface AgentSetupDraft {
  task: string;
  imageAttachments: ChatImageAttachment[];
}

/** Reads the mounted composer's draft without introducing another draft owner. */
export interface AgentSetupDraftReader {
  getDraft(): AgentSetupDraft;
}

export function copySetupDraft(draft: AgentSetupDraft): AgentSetupDraft {
  return {
    task: draft.task,
    // The source composer owns its object URLs. Data URLs remain valid after it unmounts.
    imageAttachments: draft.imageAttachments.map((image) => ({
      ...image,
      previewUrl: image.dataUrl,
    })),
  };
}
