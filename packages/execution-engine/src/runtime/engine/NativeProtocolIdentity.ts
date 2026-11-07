export function toProtocolId(prefix: string, value: string): string {
  if (new RegExp(`^${prefix}_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$`).test(value)) {
    return value;
  }
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  const suffix = sanitized.length >= 6 ? sanitized : `${sanitized}000000`;
  return `${prefix}_${suffix}`;
}
