import { describe, expect, it } from "vitest";
import { requiresWorkspaceBootstrap } from "./WorkspaceBootstrapModePolicy.js";

describe("WorkspaceBootstrapModePolicy", () => {
  it("does not require workspace bootstrap for ordinary chat", () => {
    expect(requiresWorkspaceBootstrap("what should we do today?")).toBe(false);
    expect(requiresWorkspaceBootstrap("which model do you prefer?")).toBe(false);
  });

  it("requires workspace bootstrap for file and git prompts", () => {
    expect(requiresWorkspaceBootstrap("what is in middleware.ts?")).toBe(true);
    expect(requiresWorkspaceBootstrap("what files changed?")).toBe(true);
    expect(requiresWorkspaceBootstrap("which directory has the app?")).toBe(
      true,
    );
    expect(requiresWorkspaceBootstrap("what branch is this PR on?")).toBe(true);
  });
});
