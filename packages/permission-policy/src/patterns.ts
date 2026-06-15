import type { PermissionRule } from "./types.js";

export function matchesWildcardPattern(
  pattern: string,
  value: string,
): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;

  while (valueIndex < value.length) {
    const token = pattern[patternIndex];
    if (token === "?" || token === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (token === "*") {
      starIndex = patternIndex;
      starValueIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }

  while (pattern[patternIndex] === "*") {
    patternIndex += 1;
  }

  return patternIndex === pattern.length;
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

export function normalizePolicySubject(subject: string): string {
  return subject.replaceAll("\\", "/").replace(/^\.\//u, "");
}
