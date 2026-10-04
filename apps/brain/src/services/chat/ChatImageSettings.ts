import { z } from "zod";
import type { Env } from "../../types/ai";

// OpenCode's provider-image defaults, with a hard decoding ceiling for Workers.
const ChatImageSettingsSchema = z.object({
  autoResize: z.boolean().default(true),
  maxWidth: z.number().int().positive().max(4_096).default(2_000),
  maxHeight: z.number().int().positive().max(4_096).default(2_000),
  maxBase64Bytes: z
    .number()
    .int()
    .min(128)
    .max(5 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  maxDecodedPixels: z
    .number()
    .int()
    .positive()
    .max(12_000_000)
    .default(12_000_000),
});

export type ChatImageSettings = z.infer<typeof ChatImageSettingsSchema>;
export const DEFAULT_CHAT_IMAGE_SETTINGS = ChatImageSettingsSchema.parse({});

export function resolveChatImageSettings(env: Partial<Env>): ChatImageSettings {
  return ChatImageSettingsSchema.parse({
    autoResize:
      env.CHAT_IMAGE_AUTO_RESIZE === undefined
        ? undefined
        : z.enum(["true", "false"]).parse(env.CHAT_IMAGE_AUTO_RESIZE) ===
          "true",
    maxWidth: readNumber(env.CHAT_IMAGE_MAX_WIDTH),
    maxHeight: readNumber(env.CHAT_IMAGE_MAX_HEIGHT),
    maxBase64Bytes: readNumber(env.CHAT_IMAGE_MAX_BASE64_BYTES),
    maxDecodedPixels: readNumber(env.CHAT_IMAGE_MAX_DECODE_PIXELS),
  });
}

function readNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}
