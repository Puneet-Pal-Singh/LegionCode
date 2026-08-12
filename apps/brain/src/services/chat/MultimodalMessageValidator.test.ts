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
      "corr-1",
    );

    expect(result.messages).toHaveLength(1);
  });

  it("accepts image parts without classifying model or run-mode support", () => {
    expect(
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
        "corr-1",
      ).messages,
    ).toHaveLength(1);
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
        "corr-1",
      ),
    ).toThrow("does not match mimeType");
  });
});
