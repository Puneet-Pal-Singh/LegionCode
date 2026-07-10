import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_RUNTIME_FILE = join(
  process.cwd(),
  "apps/secure-agent-api/src/core/AgentRuntime.ts",
);
const FORBIDDEN_ALWAYS_AWAKE_PATTERNS = [
  /setInterval\s*\(/,
  /\.setAlarm\s*\(/,
  /while\s*\(\s*true\s*\)/,
];

describe("AgentRuntime DO lifecycle guard", () => {
  it("avoids always-awake coordinator behavior and keeps run-scoped execution", () => {
    const source = readFileSync(AGENT_RUNTIME_FILE, "utf8");
    const violations: string[] = [];

    for (const pattern of FORBIDDEN_ALWAYS_AWAKE_PATTERNS) {
      if (pattern.test(source)) {
        violations.push(`matches ${pattern.source}`);
      }
    }

    if (/(Thread|Workspace)Coordinator/.test(source)) {
      violations.push("declares forbidden thread/workspace coordinator role");
    }

    expect(violations).toEqual([]);
  });
});
