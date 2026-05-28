import { describe, expect, it } from "vitest";
import { validateMultimodalMessages } from "./MultimodalMessageValidator";

describe("validateMultimodalMessages", () => {
  it("accepts valid user image parts", () => {
    const result = validateMultimodalMessages(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect this" },
            {
              type: "image",
              image: "data:image/png;base64,aGVsbG8=",
              mimeType: "image/png",
            },
          ],
        },
      ],
      "build",
      "corr-1",
    );

    expect(result.hasImages).toBe(true);
    expect(result.imageCount).toBe(1);
    expect(result.totalImageBytes).toBe(5);
  });

  it("rejects image parts in plan mode", () => {
    expect(() =>
      validateMultimodalMessages(
        [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: "data:image/png;base64,aGVsbG8=",
                mimeType: "image/png",
              },
            ],
          },
        ],
        "plan",
        "corr-1",
      ),
    ).toThrow("Image attachments are only supported in build mode");
  });

  it("rejects mismatched data URL MIME type", () => {
    expect(() =>
      validateMultimodalMessages(
        [
          {
            role: "user",
            content: [
              {
                type: "image",
                image: "data:image/png;base64,aGVsbG8=",
                mimeType: "image/jpeg",
              },
            ],
          },
        ],
        "build",
        "corr-1",
      ),
    ).toThrow("does not match mimeType");
  });
});
