import type { Message } from "@ai-sdk/react";
import { z } from "zod";
import { ArtifactPreview } from "../ArtifactPreview";
import type { ArtifactOpenHandler } from "../artifactOpen";

const codeArtifactArgsSchema = z.object({
  path: z.string().optional(),
  content: z.string().optional(),
});

export function MessageArtifacts({
  message,
  onArtifactOpen,
}: {
  message: Message;
  onArtifactOpen?: ArtifactOpenHandler;
}) {
  return message.toolInvocations
    ?.filter((invocation) => invocation.toolName === "create_code_artifact")
    .map((invocation, index) => {
      const args = toArtifactArgs(invocation.args);
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

function toArtifactArgs(value: unknown): {
  path?: string;
  content?: string;
} {
  const parsed = codeArtifactArgsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
