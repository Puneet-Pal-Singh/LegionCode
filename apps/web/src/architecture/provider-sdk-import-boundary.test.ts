import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SOURCE_ROOT = join(process.cwd(), "src");
const SDK_IMPORT_PATH = "@repo/platform-client-sdk";
const ALLOWED_IMPORT_FILES = new Set([
  "services/api/providerClient.ts",
  "services/api/lifecycleClient.ts",
]);

describe("Architecture Boundary: Provider SDK import ownership", () => {
  it("blocks @repo/platform-client-sdk imports outside provider API boundary", () => {
    const violations = collectSourceFiles(SOURCE_ROOT)
      .filter((filePath) => !isAllowedImportFile(filePath))
      .filter((filePath) => containsSdkImport(filePath))
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

function isAllowedImportFile(filePath: string): boolean {
  return ALLOWED_IMPORT_FILES.has(relative(SOURCE_ROOT, filePath));
}

function containsSdkImport(filePath: string): boolean {
  return readFileSync(filePath, "utf8").includes(SDK_IMPORT_PATH);
}
