import { describe, expect, it } from "vitest";
import {
  detectCrossRepoTarget,
  getSelectedRepoRef,
  isDestructiveActionPrompt,
  parsePermissionApprovalDirective,
} from "./RepositoryPermissionPolicy.js";

describe("RepositoryPermissionPolicy", () => {
  it("detects cross-repo targets from repository references", () => {
    const selectedRepo = getSelectedRepoRef({
      owner: "sourcegraph",
      repo: "legioncode",
    });
    const prompt = "Please check repository acme/platform-core for regressions.";

    const detected = detectCrossRepoTarget(prompt, selectedRepo);

    expect(detected).toBe("acme/platform-core");
  });

  it("ignores repo references that match the selected repository", () => {
    const selectedRepo = getSelectedRepoRef({
      owner: "sourcegraph",
      repo: "legioncode",
    });
    const prompt = "Inspect repository sourcegraph/legioncode for README issues.";

    const detected = detectCrossRepoTarget(prompt, selectedRepo);

    expect(detected).toBeNull();
  });

  it("ignores non-repository owner/repo-like tokens such as api/gh", () => {
    const selectedRepo = getSelectedRepoRef({
      owner: "puneet-pal-singh",
      repo: "legioncode",
    });
    const prompt = "Use github api/gh to fetch checks.";

    const detected = detectCrossRepoTarget(prompt, selectedRepo);

    expect(detected).toBeNull();
  });

  it("parses cross-repo and destructive approval directives", () => {
    const crossRepoDirective = parsePermissionApprovalDirective(
      "approve cross-repo acme/platform-core for 30m",
    );
    const destructiveDirective = parsePermissionApprovalDirective(
      "allow destructive actions for 2h",
    );

    expect(crossRepoDirective.crossRepo?.repoRef).toBe("acme/platform-core");
    expect(crossRepoDirective.isApprovalOnlyPrompt).toBe(true);
    expect(destructiveDirective.destructive?.ttlMs).toBe(2 * 60 * 60 * 1000);
    expect(destructiveDirective.isApprovalOnlyPrompt).toBe(true);
  });

  it("detects destructive action prompts", () => {
    expect(isDestructiveActionPrompt("run git reset --hard HEAD~1")).toBe(true);
    expect(isDestructiveActionPrompt("please rm -rf node_modules")).toBe(true);
    expect(isDestructiveActionPrompt("check README.md")).toBe(false);
  });
});
