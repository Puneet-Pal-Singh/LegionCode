import { describe, expect, it } from "vitest";
import {
  formatAttachmentSize,
  isChatImageMimeType,
  toImageParts,
  type ChatImageAttachment,
} from "./chatImageAttachments";

describe("chatImageAttachments", () => {
  it("narrows supported image MIME types without accepting unknown values", () => {
    expect(isChatImageMimeType("image/png")).toBe(true);
    expect(isChatImageMimeType("image/avif")).toBe(false);
  });

  it("maps attachments into provider image parts", () => {
    const attachment: ChatImageAttachment = {
      id: "image-1",
      name: "screen.png",
      mediaType: "image/png",
      dataUrl: "data:image/png;base64,aGVsbG8=",
      previewUrl: "blob:preview",
      byteSize: 5,
      source: "paste",
    };

    expect(toImageParts([attachment])).toEqual([
      {
        type: "image",
        image: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        name: "screen.png",
      },
    ]);
  });

  it("formats clean megabyte values without noisy decimal places", () => {
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatAttachmentSize(5.25 * 1024 * 1024)).toBe("5.3 MB");
  });
});
