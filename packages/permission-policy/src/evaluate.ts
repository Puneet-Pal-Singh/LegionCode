import {
  findLastMatchingRule,
  matchesWildcardPattern,
  normalizePolicySubject,
} from "./patterns.js";
import { classifyToolAction, riskLevelForDomain } from "./risk.js";
import type {
  NetworkPolicy,
  PermissionEffect,
  PermissionPolicy,
  PermissionRequest,
  PermissionRule,
  PolicyDecisionResult,
  PolicyDomain,
  RiskLevel,
  RuleSetPolicy,
} from "./types.js";

export function evaluatePermission(
  policy: PermissionPolicy,
  request: PermissionRequest,
): PolicyDecisionResult {
  switch (request.domain) {
    case "command":
      return evaluateRuleSet("command", request.command, policy.commands);
    case "path":
      return evaluatePathPermission(policy.paths, request.path, request.operation);
    case "network":
      return evaluateNetworkPermission(policy.network, request.url);
    case "git":
      return evaluateRuleSet("git", request.operation, policy.git);
    case "secret":
      return evaluateRuleSet("secret", request.secretRef, policy.secrets);
    case "tool":
      return evaluateToolPermission(policy.tools, request.toolName, request.action);
  }
}

export function evaluateRuleSet(
  domain: PolicyDomain,
  rawSubject: string,
  policy: RuleSetPolicy,
): PolicyDecisionResult {
  const subject = normalizePolicySubject(rawSubject);
  const matchedRule = findLastMatchingRule(policy.rules, subject);
  const effect = matchedRule?.effect ?? policy.defaultEffect;
  const riskLevel = matchedRule?.riskLevel ?? riskLevelForDomain(domain);

  return createDecision({ domain, subject, effect, matchedRule, riskLevel });
}

export function evaluatePathPermission(
  policy: RuleSetPolicy,
  rawPath: string,
  operation: string,
): PolicyDecisionResult {
  const subject = normalizePolicySubject(rawPath);

  if (isPathTraversal(subject)) {
    return deny("path", subject, "Path traversal outside the workspace is denied.");
  }

  const matchedRule = findLastMatchingRule(policy.rules, subject);
  const effect = matchedRule?.effect ?? policy.defaultEffect;
  const riskLevel = matchedRule?.riskLevel ?? pathRiskLevel(operation);

  return createDecision({ domain: "path", subject, effect, matchedRule, riskLevel });
}

export function evaluateNetworkPermission(
  policy: NetworkPolicy,
  rawUrl: string,
): PolicyDecisionResult {
  const parsedUrl = parsePolicyUrl(rawUrl);

  if (parsedUrl === null) {
    return deny("network", rawUrl, "Invalid URLs are denied.");
  }

  const matchedRule = findLastMatchingNetworkRule(policy.rules, parsedUrl);

  if (isLocalNetworkHost(parsedUrl.hostname) && matchedRule?.effect !== "allow") {
    return deny("network", parsedUrl.href, "Local network access requires an allow rule.");
  }

  const effect = matchedRule?.effect ?? policy.defaultEffect;
  const riskLevel = matchedRule?.riskLevel ?? "high";

  return createDecision({
    domain: "network",
    subject: parsedUrl.href,
    effect,
    matchedRule,
    riskLevel,
  });
}

export function evaluateToolPermission(
  policy: RuleSetPolicy,
  toolName: string,
  action?: string,
): PolicyDecisionResult {
  const subject = normalizePolicySubject(action ? `${toolName}:${action}` : toolName);
  const matchedRule = findLastMatchingToolRule(policy.rules, toolName, subject);
  const effect = matchedRule?.effect ?? policy.defaultEffect;
  const risk = classifyToolAction({ domain: "tool", toolName, action });
  const riskLevel = matchedRule?.riskLevel ?? risk.level;

  return createDecision({ domain: "tool", subject, effect, matchedRule, riskLevel });
}

function createDecision(input: {
  domain: PolicyDomain;
  subject: string;
  effect: PermissionEffect;
  matchedRule: PermissionRule | null;
  riskLevel: RiskLevel;
}): PolicyDecisionResult {
  const reason = input.matchedRule?.reason ?? defaultReason(input);

  if (input.effect === "ask") {
    return {
      ...input,
      effect: "ask",
      reason,
      approval: buildApprovalRequest(input, reason),
    };
  }

  return { ...input, effect: input.effect, reason, approval: null };
}

function buildApprovalRequest(
  input: {
    domain: PolicyDomain;
    subject: string;
    matchedRule: PermissionRule | null;
  },
  reason: string,
) {
  return {
    prompt:
      input.matchedRule?.approvalPrompt ??
      `Allow ${input.domain} action for "${input.subject}"? ${reason}`,
    suggestedRules: [
      {
        id: `${input.domain}.session.${input.subject}`,
        pattern: input.subject,
        effect: "allow",
        reason: "Session-scoped approval suggestion.",
      },
    ],
  } as const;
}

function deny(
  domain: PolicyDomain,
  subject: string,
  reason: string,
): PolicyDecisionResult {
  return {
    domain,
    subject,
    effect: "deny",
    reason,
    riskLevel: "critical",
    matchedRule: null,
    approval: null,
  };
}

function defaultReason(input: {
  domain: PolicyDomain;
  effect: PermissionEffect;
  matchedRule: PermissionRule | null;
}) {
  if (input.matchedRule !== null) {
    return `Matched ${input.domain} policy rule "${input.matchedRule.id}".`;
  }

  return `Applied ${input.domain} default policy "${input.effect}".`;
}

function findLastMatchingNetworkRule(
  rules: readonly PermissionRule[],
  url: URL,
): PermissionRule | null {
  let matchedRule: PermissionRule | null = null;

  for (const rule of rules) {
    if (matchesWildcardPattern(rule.pattern, url.hostname)) {
      matchedRule = rule;
    } else if (matchesWildcardPattern(rule.pattern, url.href)) {
      matchedRule = rule;
    }
  }

  return matchedRule;
}

function findLastMatchingToolRule(
  rules: readonly PermissionRule[],
  toolName: string,
  subject: string,
): PermissionRule | null {
  let matchedRule: PermissionRule | null = null;

  for (const rule of rules) {
    if (matchesWildcardPattern(rule.pattern, toolName)) {
      matchedRule = rule;
    } else if (matchesWildcardPattern(rule.pattern, subject)) {
      matchedRule = rule;
    }
  }

  return matchedRule;
}

function parsePolicyUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isPathTraversal(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.includes("/../");
}

function isLocalNetworkHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./u.test(hostname)
  );
}

function pathRiskLevel(operation: string): RiskLevel {
  if (operation === "read" || operation === "list") {
    return "low";
  }

  return "medium";
}
