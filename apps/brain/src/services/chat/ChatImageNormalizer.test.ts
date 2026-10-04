import { describe, expect, it, vi } from "vitest";
import { PhotonImage } from "@cf-wasm/photon";
import { imageSize } from "image-size";
import { normalizeChatImage } from "./ChatImageNormalizer";
import {
  DEFAULT_CHAT_IMAGE_SETTINGS,
  resolveChatImageSettings,
} from "./ChatImageSettings";
import { PNG_BYTES } from "./__tests__/ImageFixtures";

describe("chat image decoding and provider normalization", () => {
  it("keeps valid PNG, JPEG, WebP, and GIF bytes when they fit the provider policy", () => {
    const image = new PhotonImage(new Uint8Array([255, 255, 255, 255]), 1, 1);
    try {
      const gif = Uint8Array.from(
        atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
        (c) => c.charCodeAt(0),
      );
      for (const [bytes, mediaType] of [
        [PNG_BYTES, "image/png"],
        [image.get_bytes_jpeg(80), "image/jpeg"],
        [image.get_bytes_webp(), "image/webp"],
        [gif, "image/gif"],
      ] as const) {
        const normalized = normalizeChatImage(
          bytes,
          mediaType,
          DEFAULT_CHAT_IMAGE_SETTINGS,
        );
        expect(normalized).toEqual({ bytes, mediaType });
      }
    } finally {
      image.free();
    }
  });

  it("rejects signature-only images and truncated images with valid dimensions", () => {
    expect(() =>
      normalizeChatImage(
        PNG_BYTES.slice(0, 8),
        "image/png",
        DEFAULT_CHAT_IMAGE_SETTINGS,
      ),
    ).toThrow();
    // IHDR remains intact; checking signatures and dimensions alone passes this file.
    expect(imageSize(PNG_BYTES.slice(0, 40))).toMatchObject({
      width: 1,
      height: 1,
    });
    expect(() =>
      normalizeChatImage(
        PNG_BYTES.slice(0, 40),
        "image/png",
        DEFAULT_CHAT_IMAGE_SETTINGS,
      ),
    ).toThrow("could not be decoded");
    // Decoder failure must not poison subsequent requests in the same isolate.
    expect(
      normalizeChatImage(PNG_BYTES, "image/png", DEFAULT_CHAT_IMAGE_SETTINGS)
        .bytes,
    ).toEqual(PNG_BYTES);
  });

  it("rejects compressed pixel bombs before allocating decoder memory", () => {
    const bytes = PNG_BYTES.slice();
    const header = new DataView(bytes.buffer);
    header.setUint32(16, 100_000);
    header.setUint32(20, 100_000);
    const decode = vi.spyOn(PhotonImage, "new_from_byteslice");
    try {
      expect(() =>
        normalizeChatImage(bytes, "image/png", DEFAULT_CHAT_IMAGE_SETTINGS),
      ).toThrow("safe decoding limit");
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it("resizes to configured dimensions and respects disabling automatic resizing", () => {
    const image = new PhotonImage(
      new Uint8Array(100 * 40 * 4).fill(255),
      100,
      40,
    );
    try {
      const bytes = image.get_bytes();
      const settings = {
        ...DEFAULT_CHAT_IMAGE_SETTINGS,
        maxWidth: 50,
        maxHeight: 30,
      };
      const result = normalizeChatImage(bytes, "image/png", settings);
      expect(imageSize(result.bytes)).toMatchObject({ width: 50, height: 20 });
      expect(() =>
        normalizeChatImage(bytes, "image/png", {
          ...settings,
          autoResize: false,
        }),
      ).toThrow("configured dimensions");
    } finally {
      image.free();
    }
  });

  it("bounds encoded bytes independently from image dimensions", () => {
    const pixels = new Uint8Array(200 * 80 * 4);
    for (let i = 0; i < pixels.length; i += 1)
      pixels[i] = (i * 73 + Math.floor(i / 13)) % 256;
    const image = new PhotonImage(pixels, 200, 80);
    try {
      const bytes = image.get_bytes();
      expect(4 * Math.ceil(bytes.length / 3)).toBeGreaterThan(1_024);
      const result = normalizeChatImage(bytes, "image/png", {
        ...DEFAULT_CHAT_IMAGE_SETTINGS,
        maxBase64Bytes: 1_024,
      });
      expect(4 * Math.ceil(result.bytes.length / 3)).toBeLessThanOrEqual(1_024);
      expect(imageSize(result.bytes).width).toBeLessThanOrEqual(200);
    } finally {
      image.free();
    }
  });

  it("resolves settings explicitly and rejects invalid or unsafe configuration", () => {
    expect(resolveChatImageSettings({})).toEqual(DEFAULT_CHAT_IMAGE_SETTINGS);
    expect(
      resolveChatImageSettings({
        CHAT_IMAGE_AUTO_RESIZE: "false",
        CHAT_IMAGE_MAX_WIDTH: "1000",
      }),
    ).toMatchObject({ autoResize: false, maxWidth: 1_000 });
    expect(() =>
      resolveChatImageSettings({ CHAT_IMAGE_MAX_WIDTH: "0" }),
    ).toThrow();
    expect(() =>
      resolveChatImageSettings({ CHAT_IMAGE_MAX_DECODE_PIXELS: "999999999" }),
    ).toThrow();
  });
});
