import type { PermissionRule } from "./types.js";

const REGEXP_SPECIAL_CHARACTERS = /[\\^$+.()|[\]{}]/g;

export function matchesWildcardPattern(pattern: string, value: string): boolean {
  return wildcardPatternToRegExp(pattern).test(value);
}

export function findLastMatchingRule(
  rules: readonly PermissionRule[],
  subject: string,
): PermissionRule | null {
  let matchedRule: PermissionRule | null = null;

  for (const rule of rules) {
    if (matchesWildcardPattern(rule.pattern, subject)) {
      matchedRule = rule;
    }
  }

  return matchedRule;
}

export function wildcardPatternToRegExp(pattern: string): RegExp {
  const escapedPattern = pattern.replace(REGEXP_SPECIAL_CHARACTERS, "\\$&");
  const regexpSource = escapedPattern.replaceAll("*", ".*").replaceAll("?", ".");

  return new RegExp(`^${regexpSource}$`, "u");
}

export function normalizePolicySubject(subject: string): string {
  return subject.replaceAll("\\", "/").replace(/^\.\//u, "");
}
