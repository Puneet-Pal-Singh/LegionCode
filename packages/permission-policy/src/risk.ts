import type { PolicyDomain, RiskLevel } from "./types.js";

export const RISK_CATEGORIES = [
  "read",
  "write",
  "command",
  "network",
  "git_read",
  "git_mutation",
  "secret_access",
  "external_service",
  "package_manager",
] as const;

export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export type RiskClassification = {
  level: RiskLevel;
  categories: readonly RiskCategory[];
  requiresApproval: boolean;
  rationale: string;
};

export type ToolActionRiskRequest = {
  domain: PolicyDomain;
  toolName?: string;
  action?: string;
};

export function classifyToolAction(
  request: ToolActionRiskRequest,
): RiskClassification {
  const text = `${request.domain}:${request.toolName ?? ""}:${request.action ?? ""}`;
  const normalizedText = text.toLowerCase();

  if (normalizedText.includes("secret") || normalizedText.includes("token")) {
    return critical("secret_access", "Secret access can expose credentials.");
  }

  if (request.domain === "network" || normalizedText.includes("webfetch")) {
    return high("network", "Network access crosses the workspace boundary.");
  }

  if (request.domain === "git") {
    return classifyGitAction(normalizedText);
  }

  if (request.domain === "command") {
    return high("command", "Shell commands can mutate state or access resources.");
  }

  return classifyLocalAction(request.domain, normalizedText);
}

export function riskLevelForDomain(domain: PolicyDomain): RiskLevel {
  const classification = classifyToolAction({ domain });

  return classification.level;
}

function classifyGitAction(normalizedText: string): RiskClassification {
  if (isGitRead(normalizedText)) {
    return low("git_read", "Read-only git inspection stays within repository state.");
  }

  return high("git_mutation", "Git mutations change repository history or refs.");
}

function classifyLocalAction(
  domain: PolicyDomain,
  normalizedText: string,
): RiskClassification {
  if (domain === "path" && isWriteLike(normalizedText)) {
    return medium("write", "Workspace file writes should be policy checked.");
  }

  if (domain === "tool" && isWriteLike(normalizedText)) {
    return medium("write", "Tool writes can alter workspace files.");
  }

  return low("read", "Read-only local actions are low risk.");
}

function isGitRead(normalizedText: string): boolean {
  return ["status", "diff", "log", "show", "rev-parse"].some((operation) =>
    normalizedText.includes(operation),
  );
}

function isWriteLike(normalizedText: string): boolean {
  return ["write", "edit", "delete", "patch", "apply_patch"].some((token) =>
    normalizedText.includes(token),
  );
}

function low(category: RiskCategory, rationale: string): RiskClassification {
  return { level: "low", categories: [category], requiresApproval: false, rationale };
}

function medium(category: RiskCategory, rationale: string): RiskClassification {
  return { level: "medium", categories: [category], requiresApproval: true, rationale };
}

function high(category: RiskCategory, rationale: string): RiskClassification {
  return { level: "high", categories: [category], requiresApproval: true, rationale };
}

function critical(category: RiskCategory, rationale: string): RiskClassification {
  return { level: "critical", categories: [category], requiresApproval: true, rationale };
}
