import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);

const LIVE_TOOL_AUTHORITY_PATHS = [
  "apps/brain/src/runtime",
  "packages/execution-engine/src/runtime/agents",
  "packages/execution-engine/src/runtime/engine",
  "packages/execution-engine/src/runtime/lib",
  "packages/execution-engine/src/runtime/tools",
];

const BLOCKED_LIVE_AUTHORITY_PATTERNS = [
  /CodingToolGateway\.js/,
  /\bGoldenFlow\b/,
  /\bgetGoldenFlowToolRegistry\b/,
  /\benforceGoldenFlowToolFloor\b/,
  /\bisGoldenFlowToolName\b/,
  /\bisMutatingGoldenFlowToolName\b/,
  /\bGoldenFlowToolName\b/,
];

describe("runtime tool authority boundary", () => {
  it("keeps live Brain/runtime paths on CodingToolRegistry", () => {
    const violations = collectLiveSourceFiles()
      .map((filePath) => ({
        filePath,
        content: readFileSync(filePath, "utf8"),
      }))
      .flatMap(({ filePath, content }) =>
        BLOCKED_LIVE_AUTHORITY_PATTERNS.filter((pattern) =>
          pattern.test(content),
        ).map((pattern) => ({
          filePath: relative(REPO_ROOT, filePath),
          pattern: pattern.source,
        })),
      );

    expect(violations).toEqual([]);
  });

  it("quarantines GoldenFlow compatibility behind the named legacy adapter", () => {
    const removedGatewayPath = join(
      REPO_ROOT,
      "packages/execution-engine/src/runtime/contracts/CodingToolGateway.ts",
    );
    const adapterPath = join(
      REPO_ROOT,
      "packages/execution-engine/src/runtime/contracts/LegacyGoldenFlowToolRegistryAdapter.ts",
    );
    const adapter = readFileSync(adapterPath, "utf8");

    expect(existsSync(removedGatewayPath)).toBe(false);
    expect(adapter).toContain("Quarantined legacy adapter");
    expect(adapter).toContain("Deletion criteria:");
    expect(adapter).toContain("Canonical path:");
  });
});

function collectLiveSourceFiles(): string[] {
  return LIVE_TOOL_AUTHORITY_PATHS.flatMap((path) =>
    collectSourceFiles(join(REPO_ROOT, path)),
  ).filter((path) => !path.endsWith(".test.ts"));
}

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = join(directory, entry);
    if (statSync(entryPath).isDirectory()) {
      return collectSourceFiles(entryPath);
    }
    return entryPath.endsWith(".ts") || entryPath.endsWith(".tsx")
      ? [entryPath]
      : [];
  });
}
