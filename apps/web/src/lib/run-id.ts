const RUN_ID_PATTERN = /^run_[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/;

export function createRunId(): string {
  return `run_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function isCanonicalRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}
