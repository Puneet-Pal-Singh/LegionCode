import type { Message } from "@ai-sdk/react";
import { ChatImageAttachmentRefSchema } from "@repo/shared-types";
import type { ChatImagePreview } from "@legioncode/client-ui";
import type { HydrationStatus } from "../services/ChatHydrationService";

export type SavedChatSourcesStatus =
  | "loading"
  | "ready"
  | "partial"
  | "failed"
  | "recovery-required";

export interface SavedChatSourcesProjection {
  images: ChatImagePreview[];
  status: SavedChatSourcesStatus;
  error: string | null;
}

export function projectSavedChatSources(input: {
  messages: readonly Message[];
  restoredUserMessageIds: ReadonlySet<string>;
  hydrationStatus: HydrationStatus | "loading" | "idle";
  isHydrating: boolean;
  hasHydrated: boolean;
  hydrationError: string | null;
  resolveImageSource: (source: string) => string | undefined;
}): SavedChatSourcesProjection {
  const images: ChatImagePreview[] = [];
  const seenAttachmentIds = new Set<string>();

  for (const message of input.messages) {
    if (
      message.role !== "user" ||
      !input.restoredUserMessageIds.has(message.id)
    ) {
      continue;
    }
    const data = (message as Message & { data?: unknown }).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const metadata = (data as Record<string, unknown>).metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      continue;
    }
    const refs = (metadata as Record<string, unknown>).imageAttachments;
    if (!Array.isArray(refs)) continue;
    for (const value of refs) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const parsed = ChatImageAttachmentRefSchema.safeParse({
        type: record.type,
        attachmentId: record.attachmentId,
        name: record.name,
        mediaType: record.mediaType,
        byteSize: record.byteSize,
      });
      if (!parsed.success || seenAttachmentIds.has(parsed.data.attachmentId)) {
        continue;
      }
      seenAttachmentIds.add(parsed.data.attachmentId);
      const resolvedSource =
        typeof record.src === "string"
          ? input.resolveImageSource(record.src)
          : undefined;
      images.push({
        id: parsed.data.attachmentId,
        name: parsed.data.name,
        mediaType: parsed.data.mediaType,
        byteSize: parsed.data.byteSize,
        ...(resolvedSource ? { src: resolvedSource } : {}),
      });
    }
  }

  const status: SavedChatSourcesStatus = input.isHydrating || !input.hasHydrated
    ? "loading"
    : input.hydrationStatus === "partial"
      ? "partial"
      : input.hydrationStatus === "recovery-required"
        ? "recovery-required"
        : input.hydrationStatus === "failed"
          ? "failed"
          : "ready";

  return {
    images,
    status,
    error: status === "partial" || status === "failed" || status === "recovery-required"
      ? input.hydrationError
      : null,
  };
}
