import { describe, expect, it } from "vitest";
import { formatModelDisplayName } from "./modelDisplayName";

describe("formatModelDisplayName", () => {
  it("turns provider ids into readable product names", () => {
    expect(
      formatModelDisplayName({ id: "gpt-5.6-luna", name: "gpt-5.6-luna" }),
    ).toBe("GPT-5.6 Luna");
    expect(
      formatModelDisplayName({
        id: "chatgpt-image-latest",
        name: "chatgpt-image-latest",
      }),
    ).toBe("ChatGPT Image Latest");
  });

  it("preserves names already supplied with product casing", () => {
    expect(formatModelDisplayName({ id: "gpt-4o", name: "GPT-4o" })).toBe(
      "GPT-4o",
    );
  });

  it("drops provider qualification from raw ids", () => {
    expect(
      formatModelDisplayName({
        id: "openai/gpt-4.1-mini",
        name: "openai/gpt-4.1-mini",
      }),
    ).toBe("GPT-4.1 Mini");
    expect(
      formatModelDisplayName({
        id: "z-ai/glm-4.5-air:free",
        name: "z-ai/glm-4.5-air:free",
      }),
    ).toBe("GLM 4.5 Air Free");
  });
});
