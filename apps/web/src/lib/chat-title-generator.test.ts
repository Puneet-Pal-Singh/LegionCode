import { describe, expect, it } from "vitest";
import { generateChatTitleFromPrompt } from "./chat-title-generator";

describe("generateChatTitleFromPrompt", () => {
  it("creates short deterministic titles from user prompts", () => {
    expect(
      generateChatTitleFromPrompt("check my hero component and make it pretty"),
    ).toBe("Improve Hero Component");
    expect(generateChatTitleFromPrompt("chat flashing and timeout")).toBe(
      "Fix Chat Flashing Timeout",
    );
    expect(generateChatTitleFromPrompt("clarify final workflow message?")).toBe(
      "Clarify Final Workflow Message",
    );
    expect(
      generateChatTitleFromPrompt("lets upgrade our footer Footer.tsx"),
    ).toBe("Upgrade Footer");
    expect(
      generateChatTitleFromPrompt("check my readme and tell about this project?"),
    ).toBe("Review Project README");
    expect(generateChatTitleFromPrompt("Hi lets add hero section")).toBe(
      "Add Hero Section",
    );
    expect(
      generateChatTitleFromPrompt("Make my hero page @index.tsx prettier."),
    ).toBe("Improve Hero Page");
  });

  it("returns New Task when the prompt has no useful words", () => {
    expect(generateChatTitleFromPrompt(" @Footer.tsx please ")).toBe(
      "New Task",
    );
  });
});
