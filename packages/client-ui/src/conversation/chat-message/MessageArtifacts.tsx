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
  storedCalls = [],
}: {
  message?: Message;
  onArtifactOpen?: ArtifactOpenHandler;
  loadArtifactContent?: (key: string, signal?: AbortSignal) => Promise<string>;
  /** Source-projected calls for read-only transcript rows, without AI SDK message casts. */
  storedCalls?: readonly StoredCodeArtifactCall[];
}) {
  const calls = [
    ...(message?.toolInvocations
      ?.filter((invocation) => invocation.toolName === "create_code_artifact")
      .map((invocation) => ({
        toolCallId: invocation.toolCallId,
        args: invocation.args,
        status: invocation.state,
      })) ?? []),
    ...storedCalls
      .filter((call) => call.toolName === "create_code_artifact")
      .map((call) => ({
        toolCallId: call.toolCallId,
        args: call.args,
        status: "result" as const,
      })),
  ];

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

export interface StoredCodeArtifactCall {
  toolName: string;
  toolCallId?: string;
  args: unknown;
}

function toArtifactArgs(value: unknown): {
  path?: string;
  content?: string | { type: "r2_ref"; key: string };
} {
  const parsed = codeArtifactArgsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
