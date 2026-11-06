import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const FORBIDDEN_ADAPTER_TOKENS = [
  "OpenAIAdapter",
  "LocalMockAdapter",
  "@cloudflare/sandbox",
  "cloudflare:workers",
];
const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+["'][^"']*\/adapters\/OpenAIAdapter(\.js)?["']/,
  /from\s+["'][^"']*\/adapters\/LocalMockAdapter(\.js)?["']/,
  /from\s+["']@cloudflare\/sandbox["']/,
  /from\s+["']cloudflare:workers["']/,
];

const FORBIDDEN_BRANCH_PATTERNS = [
  /if\s*\(\s*providerId\s*===\s*["']openai["']\s*\)/,
  /if\s*\(\s*providerId\s*===\s*["']groq["']\s*\)/,
  /if\s*\(\s*providerId\s*===\s*["']openrouter["']\s*\)/,
  /switch\s*\(\s*providerId\s*\)/,
  /if\s*\(\s*harness[a-zA-Z0-9_]*\s*===\s*["']/,
  /switch\s*\(\s*harness[a-zA-Z0-9_]*\s*\)/,
];
const CORE_RUNTIME_SEGMENTS = ["/runtime/engine/", "/runtime/orchestration/"];
// Concrete inference belongs to this implementation/composition boundary.
// Runtime consumers must continue to use the provider port/factory.
const PROVIDER_IMPLEMENTATION_FILES = new Set([
  "src/runtime/provider/ProviderInferenceFactory.ts",
  "src/runtime/provider/adapters/OpenAIAdapter.ts",
  "src/runtime/provider/adapters/index.ts",
]);

describe("runtime adapter boundary guard", () => {
  it("prevents provider-specific adapter usage inside runtime modules", () => {
    const runtimeRoot = join(process.cwd(), "src/runtime");
    const runtimeFiles = collectTypeScriptFiles(runtimeRoot).filter(
      (filePath) => !filePath.endsWith(".test.ts"),
    );
    const violations: string[] = [];

    for (const filePath of runtimeFiles) {
      const content = readFileSync(filePath, "utf8");
      const relativePath = relative(process.cwd(), filePath);
      const ownsProviderImplementation = PROVIDER_IMPLEMENTATION_FILES.has(
        relativePath.replaceAll("\\", "/"),
      );

      for (const token of FORBIDDEN_ADAPTER_TOKENS) {
        if (ownsProviderImplementation && token === "OpenAIAdapter") continue;
        if (content.includes(token)) {
          violations.push(
            `${relativePath}: contains forbidden token "${token}"`,
          );
        }
      }

      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (
          ownsProviderImplementation &&
          pattern.source.includes("OpenAIAdapter")
        )
          continue;
        if (pattern.test(content)) {
          violations.push(
            `${relativePath}: matches forbidden adapter import pattern ${pattern.source}`,
          );
        }
      }

      const normalizedPath = filePath.replaceAll("\\", "/");
      const isCoreRuntimeFile = CORE_RUNTIME_SEGMENTS.some((segment) =>
        normalizedPath.includes(segment),
      );
      if (isCoreRuntimeFile) {
        for (const pattern of FORBIDDEN_BRANCH_PATTERNS) {
          if (pattern.test(content)) {
            violations.push(
              `${relativePath}: matches forbidden provider/harness branching pattern ${pattern.source}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function collectTypeScriptFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }

  return files;
}
