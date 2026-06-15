import { describe, expect, it } from "vitest";
import { evaluatePermission } from "./evaluate.js";
import { parsePermissionPolicy, parsePermissionRequest } from "./types.js";
import type { PermissionPolicy, RuleSetPolicy } from "./types.js";

const ASK_MEDIUM: RuleSetPolicy = {
  defaultEffect: "ask",
  defaultRiskLevel: "medium",
  rules: [],
};

const POLICY: PermissionPolicy = {
  commands: {
    ...ASK_MEDIUM,
    rules: [
      {
        id: "command.git-status",
        pattern: "git status*",
        effect: "allow",
        riskLevel: "low",
      },
    ],
  },
  paths: {
    ...ASK_MEDIUM,
    rules: [
      {
        id: "path.env",
        pattern: "read:**/.env*",
        effect: "deny",
        riskLevel: "critical",
      },
    ],
  },
  network: { ...ASK_MEDIUM, defaultRiskLevel: "high" },
  git: {
    ...ASK_MEDIUM,
    rules: [
      {
        id: "git.reset",
        pattern: "reset*",
        effect: "deny",
        riskLevel: "critical",
      },
    ],
  },
  packageManagers: { ...ASK_MEDIUM, defaultRiskLevel: "high" },
  secrets: {
    ...ASK_MEDIUM,
    defaultEffect: "deny",
    defaultRiskLevel: "critical",
  },
  externalServices: { ...ASK_MEDIUM, defaultRiskLevel: "high" },
  tools: ASK_MEDIUM,
};

describe("evaluatePermission", () => {
  it("evaluates supplied policy data without package-owned defaults", () => {
    expect(
      evaluatePermission(POLICY, {
        domain: "command",
        command: "git status --short",
      }).effect,
    ).toBe("allow");
    expect(
      evaluatePermission(POLICY, {
        domain: "package_manager",
        manager: "pnpm",
        operation: "install",
      }).effect,
    ).toBe("ask");
    expect(
      evaluatePermission(POLICY, {
        domain: "external_service",
        service: "github",
        operation: "pull_request.create",
      }).riskLevel,
    ).toBe("high");
  });

  it("includes operation context in path and secret decisions", () => {
    expect(
      evaluatePermission(POLICY, {
        domain: "path",
        operation: "read",
        path: "apps/web/.env.local",
      }).effect,
    ).toBe("deny");
    expect(
      evaluatePermission(POLICY, {
        domain: "secret",
        operation: "read",
        secretRef: "provider.openai.api_key",
      }).subject,
    ).toBe("read:provider.openai.api_key");
  });

  it("denies path traversal and local network targets without explicit allow", () => {
    expect(
      evaluatePermission(POLICY, {
        domain: "path",
        operation: "read",
        path: "../outside.txt",
      }).effect,
    ).toBe("deny");
    expect(
      evaluatePermission(POLICY, {
        domain: "network",
        operation: "fetch",
        url: "http://127.0.0.2/health",
      }).effect,
    ).toBe("deny");
  });

  it("allows local network only through an explicit operation-scoped rule", () => {
    const policy: PermissionPolicy = {
      ...POLICY,
      network: {
        defaultEffect: "ask",
        defaultRiskLevel: "high",
        rules: [
          {
            id: "network.localhost",
            pattern: "fetch:localhost",
            effect: "allow",
          },
        ],
      },
    };

    expect(
      evaluatePermission(policy, {
        domain: "network",
        operation: "fetch",
        url: "http://localhost:8787/health",
      }).effect,
    ).toBe("allow");
  });

  it("validates policy and request data at the package boundary", () => {
    expect(parsePermissionPolicy(POLICY).commands.defaultEffect).toBe("ask");
    expect(
      parsePermissionRequest({ domain: "git", operation: "commit -m test" }),
    ).toEqual({ domain: "git", operation: "commit -m test" });
  });
});
