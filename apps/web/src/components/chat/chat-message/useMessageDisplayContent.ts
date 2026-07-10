import { useMemo } from "react";
import type { Message } from "@ai-sdk/react";
import { getVisibleMessageContent } from "../AssistantMessageParts";
import { stripAssistantChangeCounts } from "./markdownTransforms";
import type { ChangedFilesSummary } from "./types";

export function useMessageDisplayContent(
  message: Message,
  isUser: boolean,
  changedFilesSummary?: ChangedFilesSummary,
): string {
  const content = useMemo(
    () =>
      getVisibleMessageContent({
        role: message.role,
        content: message.content,
      }),
    [message.content, message.role],
  );

  return useMemo(
    () =>
      !isUser && changedFilesSummary && content
        ? stripAssistantChangeCounts(content)
        : content,
    [changedFilesSummary, content, isUser],
  );
}
