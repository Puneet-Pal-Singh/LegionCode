import type { Message } from "@ai-sdk/react";
import { z } from "zod";
import { ArtifactPreview } from "../ArtifactPreview.js";
import type { ArtifactOpenHandler } from "../artifactOpen.js";

const codeArtifactArgsSchema = z.object({
  path: z.string().optional(),
  content: z.union([
    z.string(),
    z.object({ type: z.literal("r2_ref"), key: z.string().min(1) }).strict(),
  ]).optional(),
});

export function MessageArtifacts({
  message,
  onArtifactOpen,
  loadArtifactContent,
}: {
  message?: Message;
  onArtifactOpen?: ArtifactOpenHandler;
  loadArtifactContent?: (key: string, signal?: AbortSignal) => Promise<string>;
}) {
  const calls = message?.toolInvocations
      ?.filter((invocation) => invocation.toolName === "create_code_artifact")
      .map((invocation) => ({
        toolCallId: invocation.toolCallId,
        args: invocation.args,
        status: invocation.state,
      })) ?? [];

  return calls.map((call, index) => {
      const args = toArtifactArgs(call.args);
      const path = args.path || "untitled";
      const content = args.content;
      if (content === undefined || content === "") return null;
      return (
        <ArtifactPreview
          key={call.toolCallId || `tool-${index}`}
          title={path}
          content={content}
          loadContent={loadArtifactContent}
          status={call.status}
          onOpen={onArtifactOpen ?? (() => undefined)}
        />
      );
    });
}

function toArtifactArgs(value: unknown): {
  path?: string;
  content?: string | { type: "r2_ref"; key: string };
} {
  const parsed = codeArtifactArgsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
