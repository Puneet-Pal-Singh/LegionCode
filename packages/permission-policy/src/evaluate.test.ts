import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSION_POLICY } from "./defaultPolicy.js";
import { evaluatePermission } from "./evaluate.js";
import { parsePermissionPolicy, parsePermissionRequest } from "./types.js";
import type { PermissionPolicy } from "./types.js";

describe("evaluatePermission", () => {
  it("allows read-only git commands through command policy", () => {
    const decision = evaluatePermission(DEFAULT_PERMISSION_POLICY, {
      domain: "command",
      command: "git status --short",
    });

    expect(decision.effect).toBe("allow");
    expect(decision.matchedRule?.id).toBe("command.git-status");
  });

  it("asks before package manager commands", () => {
    const decision = evaluatePermission(DEFAULT_PERMISSION_POLICY, {
      domain: "command",
      command: "pnpm test",
    });

    expect(decision.effect).toBe("ask");
    if (decision.effect !== "ask") {
      throw new Error("Expected an ask decision.");
    }
    expect(decision.approval.prompt).toContain("command action");
  });

  it("denies secret-bearing path reads before default handling", () => {
    const decision = evaluatePermission(DEFAULT_PERMISSION_POLICY, {
      domain: "path",
      operation: "read",
      path: "apps/web/.env.local",
    });

    expect(decision.effect).toBe("deny");
    expect(decision.matchedRule?.id).toBe("path.env-nested");
  });

  it("denies path traversal", () => {
    const decision = evaluatePermission(DEFAULT_PERMISSION_POLICY, {
      domain: "path",
      operation: "read",
      path: "../outside.txt",
    });

    expect(decision.effect).toBe("deny");
    expect(decision.reason).toContain("Path traversal");
  });

  it("requires an explicit allow rule for local network targets", () => {
    const decision = evaluatePermission(DEFAULT_PERMISSION_POLICY, {
      domain: "network",
      operation: "fetch",
      url: "http://localhost:8787/health",
    });

    expect(decision.effect).toBe("deny");
  });

  it("allows local network targets when policy data explicitly allows them", () => {
    const policy: PermissionPolicy = {
      ...DEFAULT_PERMISSION_POLICY,
      network: {
        defaultEffect: "ask",
        allowLocalNetwork: false,
        rules: [{ id: "network.localhost", pattern: "localhost", effect: "allow" }],
      },
    };

    const decision = evaluatePermission(policy, {
      domain: "network",
      operation: "fetch",
      url: "http://localhost:8787/health",
    });

    expect(decision.effect).toBe("allow");
    expect(decision.matchedRule?.id).toBe("network.localhost");
  });

  it("denies destructive git mutations", () => {
    const decision = evaluatePermission(DEFAULT_PERMISSION_POLICY, {
      domain: "git",
      operation: "reset --hard HEAD",
    });

    expect(decision.effect).toBe("deny");
    expect(decision.riskLevel).toBe("critical");
  });

  it("denies secret access by default", () => {
    const decision = evaluatePermission(DEFAULT_PERMISSION_POLICY, {
      domain: "secret",
      operation: "read",
      secretRef: "provider.openai.api_key",
    });

    expect(decision.effect).toBe("deny");
  });

  it("validates policy and request data at the package boundary", () => {
    expect(parsePermissionPolicy(DEFAULT_PERMISSION_POLICY).defaultEffect).toBe(
      "ask",
    );

    expect(
      parsePermissionRequest({ domain: "git", operation: "commit -m test" }),
    ).toEqual({ domain: "git", operation: "commit -m test" });
  });
});
