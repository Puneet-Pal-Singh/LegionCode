export const CHAT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type ChatImageMimeType = (typeof CHAT_IMAGE_MIME_TYPES)[number];

export interface ChatImageAttachment {
  id: string;
  name: string;
  mediaType: ChatImageMimeType;
  dataUrl: string;
  previewUrl: string;
  byteSize: number;
  source: "paste" | "upload";
}

export interface ChatSubmitAttachments {
  imageAttachments: ChatImageAttachment[];
}

const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;

export function isChatImageMimeType(value: string): value is ChatImageMimeType {
  return CHAT_IMAGE_MIME_TYPES.includes(value as ChatImageMimeType);
}

export function validateNextImageAttachment(input: {
  file: File;
  existingAttachments: ChatImageAttachment[];
}): string | null {
  if (!isChatImageMimeType(input.file.type)) {
    return "Only PNG, JPEG, WebP, and GIF images can be attached.";
  }
  if (input.file.size > MAX_IMAGE_BYTES) {
    return "Each image must be 5 MB or smaller.";
  }
  if (input.existingAttachments.length >= MAX_IMAGES_PER_MESSAGE) {
    return `A message can include at most ${MAX_IMAGES_PER_MESSAGE} images.`;
  }
  const totalBytes = input.existingAttachments.reduce(
    (sum, attachment) => sum + attachment.byteSize,
    input.file.size,
  );
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    return "Attached images must be 10 MB or smaller in total.";
  }
  return null;
}

export async function createChatImageAttachment(
  file: File,
  source: "paste" | "upload",
): Promise<ChatImageAttachment> {
  return {
    id: crypto.randomUUID(),
    name: file.name || "pasted-image",
    mediaType: file.type as ChatImageMimeType,
    dataUrl: await readFileAsDataUrl(file),
    previewUrl: URL.createObjectURL(file),
    byteSize: file.size,
    source,
  };
}

export function toImageParts(attachments: ChatImageAttachment[]): Array<{
  type: "image";
  image: string;
  mimeType: ChatImageMimeType;
  name: string;
}> {
  return attachments.map((attachment) => ({
    type: "image",
    image: attachment.dataUrl,
    mimeType: attachment.mediaType,
    name: attachment.name,
  }));
}

export function toRedactedImageMetadata(
  attachments: ChatImageAttachment[],
): Array<{
  id: string;
  name: string;
  mediaType: ChatImageMimeType;
  byteSize: number;
  source: "paste" | "upload";
}> {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    byteSize: attachment.byteSize,
    source: attachment.source,
  }));
}

export function formatAttachmentSize(byteSize: number): string {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }
  if (byteSize < 1024 * 1024) {
    return `${Math.round(byteSize / 1024)} KB`;
  }
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Image attachment could not be read."));
    };
    reader.onerror = () => reject(new Error("Image attachment could not be read."));
    reader.readAsDataURL(file);
  });
}
