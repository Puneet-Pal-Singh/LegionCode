/**
 * Orchestrator Core Contract Boundary Tests
 *
 * Prevents app-local duplication of canonical orchestrator contracts.
 * All orchestration contracts must come from @legioncode/orchestrator-core.
 *
 * Canonical alignment: Plan 64 CFA1
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIR = path.dirname(CURRENT_FILE);
const BRAIN_SRC_DIR = path.resolve(CURRENT_DIR, "../..");
const PORTS_FILE = path.resolve(CURRENT_DIR, "../ports/ExecutionRuntimePort.ts");
const PORTS_INDEX = path.resolve(CURRENT_DIR, "../ports/index.ts");

function readFileContent(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      results.push(...findTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("Orchestrator Core Contract Boundary", () => {
  it("ExecutionRuntimePort.ts imports RunOrchestratorPort from @legioncode/orchestrator-core", () => {
    const content = readFileContent(PORTS_FILE);
    expect(content).toContain("@legioncode/orchestrator-core");
  });

  it("ExecutionRuntimePort.ts does not define RunOrchestratorPort locally", () => {
    const content = readFileContent(PORTS_FILE);
    expect(content).not.toMatch(/interface\s+RunOrchestratorPort\s*[<{]/);
  });

  it("ports/index.ts re-exports RunOrchestratorPort from @legioncode/orchestrator-core", () => {
    const content = readFileContent(PORTS_INDEX);
    expect(content).toContain("@legioncode/orchestrator-core");
  });

  it("no brain source file locally defines canonical orchestrator contracts", () => {
    const forbiddenPatterns = [
      /interface\s+RunOrchestratorPort\s*[<{]/,
      /type\s+OrchestratorBackend\s*=/,
      /class\s+StateMachineError\s+extends\s+Error/,
      /class\s+RunManifestMismatchError\s+extends\s+Error/,
    ];

    const tsFiles = findTsFiles(BRAIN_SRC_DIR);

    for (const file of tsFiles) {
      const content = readFileContent(file);
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(content),
          `File ${path.relative(BRAIN_SRC_DIR, file)} must not locally define canonical orchestrator contracts (matched: ${pattern})`,
        ).toBe(false);
      }
    }
  });
});
