import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(process.cwd(), "src");
const BLOCKED_PATTERNS = [
  "@legioncode/sdk",
  "services/api/providerClient",
  "/api/byok",
];

describe("Architecture Boundary: ui-kit provider transport isolation", () => {
  it("blocks provider transport imports and BYOK route coupling", () => {
    const violations = collectSourceFiles(SOURCE_ROOT)
      .filter((filePath) => containsBlockedPattern(filePath))
      .map((filePath) => relative(SOURCE_ROOT, filePath));

    expect(violations).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (!isSourceFile(fullPath) || isTestFile(fullPath)) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function isSourceFile(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".js") ||
    filePath.endsWith(".jsx")
  );
}

function isTestFile(filePath: string): boolean {
  return filePath.includes(".test.");
}

function containsBlockedPattern(filePath: string): boolean {
  const source = readFileSync(filePath, "utf8");
  return BLOCKED_PATTERNS.some((pattern) => source.includes(pattern));
}
