import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DURABLE_OBJECT_RUNTIME_FILES = [
  join(process.cwd(), "src/runtime/RunEngineRuntime.ts"),
];

const FORBIDDEN_ALWAYS_AWAKE_PATTERNS = [
  /setInterval\s*\(/,
  /setTimeout\s*\([^,]+,\s*(?:60_000|60000|300000|5_000)\s*\)/,
  /\.setAlarm\s*\(/,
  /while\s*\(\s*true\s*\)/,
];

describe("DO lifecycle guard", () => {
  it("keeps runtime DOs hibernation-friendly and avoids always-awake loops", () => {
    const violations: string[] = [];

    for (const filePath of DURABLE_OBJECT_RUNTIME_FILES) {
      const source = readFileSync(filePath, "utf8");
      for (const pattern of FORBIDDEN_ALWAYS_AWAKE_PATTERNS) {
        if (pattern.test(source)) {
          violations.push(`${filePath}: matches ${pattern.source}`);
        }
      }
      if (/(Thread|Workspace)Coordinator/.test(source)) {
        violations.push(`${filePath}: declares forbidden coordinator role`);
      }
    }

    expect(violations).toEqual([]);
  });
});
