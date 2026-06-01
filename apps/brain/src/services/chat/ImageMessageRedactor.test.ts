import { describe, expect, it } from "vitest";
import type { CoreMessage } from "ai";
import { buildRedactedMessageText } from "./ImageMessageRedactor";

describe("buildRedactedMessageText", () => {
  it("preserves text and image ordering while redacting image data", () => {
    const message: CoreMessage = {
      role: "user",
      content: [
        { type: "text", text: "before first" },
        {
          type: "image",
          image: "data:image/png;base64,aGVsbG8=",
          mimeType: "image/png",
          name: "first.png",
        },
        { type: "text", text: "between images" },
        {
          type: "image",
          image: "data:image/jpeg;base64,aGVsbG8=",
          mimeType: "image/jpeg",
          name: "second.jpg",
        },
      ],
    };

    expect(buildRedactedMessageText(message)).toBe(
      [
        "before first",
        "[Image attached: first.png, image/png, 5 B]",
        "between images",
        "[Image attached: second.jpg, image/jpeg, 5 B]",
      ].join("\n\n"),
    );
  });
});
