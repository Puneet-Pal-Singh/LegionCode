import { describe, expect, it } from "vitest";
import type { R2Bucket } from "@cloudflare/workers-types";
import { ChatMediaStore } from "./ChatMediaStore";

describe("ChatMediaStore", () => {
  it("stores validated image bytes under authenticated scope and returns typed metadata", async () => {
    const bucket = new MemoryR2Bucket();
    const store = new ChatMediaStore(bucket as unknown as R2Bucket);

    const ref = await store.putImage({
      userId: "user-1",
      sessionId: "session-1",
      attachmentId: "img_1234567890abcdef",
      image: {
        image: dataUrl(
          "image/png",
          [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        ),
        mimeType: "image/png",
        name: "screen.png",
      },
    });

    expect(ref).toMatchObject({
      type: "image_attachment",
      name: "screen.png",
      mediaType: "image/png",
      byteSize: 8,
    });
    expect(bucket.keys).toHaveLength(1);
    expect(bucket.keys[0]).toBe(
      "chat-media/user-1/session-1/img_1234567890abcdef",
    );
  });

  it.each([
    { userId: "other-user", sessionId: "session-1" },
    { userId: "user-1", sessionId: "other-session" },
  ])(
    "does not read provider images across authenticated scope: %j",
    async (scope) => {
      const bucket = new MemoryR2Bucket();
      const store = new ChatMediaStore(bucket as unknown as R2Bucket);
      const ref = await store.putImage({
        userId: "user-1",
        sessionId: "session-1",
        attachmentId: "img_1234567890abcdef",
        image: { image: "data:image/png;base64,iVBORw0KGgo=" },
      });
      await expect(
        store.getProviderImage({ ...scope, ref }),
      ).rejects.toMatchObject({ code: "CHAT_MEDIA_NOT_FOUND" });
      await expect(
        store.getProviderImage({
          userId: "user-1",
          sessionId: "session-1",
          ref,
        }),
      ).resolves.toEqual({
        type: "image",
        image: "data:image/png;base64,iVBORw0KGgo=",
        mimeType: "image/png",
      });
    },
  );

  it("rejects stored metadata and bytes that no longer match the durable reference", async () => {
    const bucket = new MemoryR2Bucket();
    const store = new ChatMediaStore(bucket as unknown as R2Bucket);
    const ref = await store.putImage({
      userId: "user-1",
      sessionId: "session-1",
      attachmentId: "img_1234567890abcdef",
      image: { image: "data:image/png;base64,iVBORw0KGgo=" },
    });
    const input = { userId: "user-1", sessionId: "session-1", ref };
    await expect(
      store.getProviderImage({ ...input, ref: { ...ref, byteSize: 9 } }),
    ).rejects.toMatchObject({ code: "CHAT_MEDIA_METADATA_INVALID" });
    await expect(
      store.getProviderImage({
        ...input,
        ref: { ...ref, mediaType: "image/jpeg" },
      }),
    ).rejects.toMatchObject({ code: "CHAT_MEDIA_METADATA_INVALID" });
    bucket.bytes.fill(0);
    await expect(store.getProviderImage(input)).rejects.toMatchObject({
      code: "CHAT_MEDIA_CONTENT_INVALID",
    });
  });

  it("rejects content whose bytes do not match its declared image type", async () => {
    const store = new ChatMediaStore(
      new MemoryR2Bucket() as unknown as R2Bucket,
    );
    await expect(
      store.putImage({
        userId: "user-1",
        sessionId: "session-1",
        attachmentId: "img_1234567890abcdef",
        image: {
          image: dataUrl("image/png", [0xff, 0xd8, 0xff]),
          mimeType: "image/png",
        },
      }),
    ).rejects.toThrow("Image bytes do not match");
  });

  it("uses different object keys for different authenticated scopes", () => {
    expect(ChatMediaStore.key("user-1", "session-1", "img_1")).not.toBe(
      ChatMediaStore.key("user-2", "session-1", "img_1"),
    );
    expect(ChatMediaStore.key("user-1", "session-1", "img_1")).not.toBe(
      ChatMediaStore.key("user-1", "session-2", "img_1"),
    );
  });
});

function dataUrl(mediaType: string, bytes: number[]): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mediaType};base64,${btoa(binary)}`;
}

class MemoryR2Bucket {
  readonly keys: string[] = [];
  bytes = new Uint8Array();
  private mediaType = "";
  async put(
    key: string,
    bytes: Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<void> {
    this.keys.push(key);
    this.bytes = bytes.slice();
    this.mediaType = options.httpMetadata.contentType;
  }
  async get(key: string) {
    return this.keys.includes(key)
      ? {
          size: this.bytes.length,
          httpMetadata: { contentType: this.mediaType },
          arrayBuffer: async () => this.bytes.slice().buffer,
        }
      : null;
  }
}
