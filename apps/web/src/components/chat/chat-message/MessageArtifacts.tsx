import type { Message } from "@ai-sdk/react";
import { ArtifactPreview } from "../ArtifactPreview";

export function MessageArtifacts({
  message,
  onArtifactOpen,
}: {
  message: Message;
  onArtifactOpen?: (path: string, content: string) => void;
}) {
  return message.toolInvocations
    ?.filter((invocation) => invocation.toolName === "create_code_artifact")
    .map((invocation, index) => {
      const args = invocation.args as Record<string, string | undefined>;
      const path = args.path || "untitled";
      const content = args.content || "";
      if (!content) return null;
      return (
        <ArtifactPreview
          key={invocation.toolCallId || `tool-${index}`}
          title={path}
          content={content}
          status={invocation.state}
          onOpen={() => onArtifactOpen?.(path, content)}
        />
      );
    });
}
