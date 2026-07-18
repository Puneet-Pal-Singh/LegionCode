const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY =
  /(?:^|_)(?:authorization|cookie|credential|password|secret|token|api_?key|access_?key|client_?secret)(?:$|_)/i;

const SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /((?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
];

export function sanitizeRuntimeEventText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (sanitized, pattern) =>
      sanitized.replace(pattern, (match, prefix: string | undefined) =>
        typeof prefix === "string"
          ? `${prefix}${REDACTED_VALUE}`
          : REDACTED_VALUE,
      ),
    value,
  );
}

export function sanitizeRuntimeEventValue(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet<object>());
}

export function sanitizeRuntimeEventRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(value, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return sanitizeRuntimeEventText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(normalizeKey(key))
        ? REDACTED_VALUE
        : sanitizeValue(entry, seen),
    ]),
  );
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.\s]+/g, "_");
}
