/**
 * Architecture Boundary Test: No Legacy Imports
 *
 * Enforces that no code imports from deprecated/legacy modules:
 * - No imports from src/legacy/**
 * - No imports from deprecated types (run.types.ts, task.types.ts)
 * - No imports from transitional core wrappers that should be removed
 *
 * This prevents regression into deprecated code patterns.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const BRAIN_SRC = path.join(__dirname, "..");

interface DeprecatedImport {
  file: string;
  line: number;
  importedModule: string;
  reason: string;
}

/**
 * Collect all TypeScript source files recursively
 */
function getAllTSFiles(dir: string, excludeDirs: string[] = []): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludeDirs.includes(entry.name) && !entry.name.startsWith(".")) {
        files.push(...getAllTSFiles(path.join(dir, entry.name), excludeDirs));
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

/**
 * Extract all import statements from a file
 */
function extractImports(
  filePath: string,
): Array<{ line: number; module: string }> {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const imports: Array<{ line: number; module: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match: import ... from "..."
    const importMatch = line.match(/import\s+(?:.*?)\s+from\s+["'](.*?)["']/);
    if (importMatch) {
      imports.push({
        line: i + 1,
        module: importMatch[1],
      });
    }

    // Match: import("...")
    const dynamicMatch = line.match(/import\s*\(\s*["'](.*?)["']\s*\)/);
    if (dynamicMatch) {
      imports.push({
        line: i + 1,
        module: dynamicMatch[1],
      });
    }
  }

  return imports;
}

describe("Architecture Boundary: No Legacy Imports", () => {
  it("should have deleted src/legacy directory entirely", () => {
    const legacyPath = path.join(BRAIN_SRC, "legacy");
    const exists = fs.existsSync(legacyPath);
    expect(
      exists,
      "src/legacy directory should not exist after PR-4 deletion sweep",
    ).toBe(false);
  });

  it("should have deleted deprecated type files", () => {
    const deprecatedTypeFiles = [
      "types/run.types.ts",
      "types/task.types.ts",
      "types/index.ts",
    ];

    for (const typeFile of deprecatedTypeFiles) {
      const filePath = path.join(BRAIN_SRC, typeFile);
      const exists = fs.existsSync(filePath);
      expect(exists, `${typeFile} should be deleted after PR-4`).toBe(false);
    }
  });

  it("should not allow any imports from legacy modules", () => {
    const allFiles = getAllTSFiles(BRAIN_SRC, ["architecture"]);
    const violations: DeprecatedImport[] = [];

    const legacyPatterns = [
      /legacy\//,
      /types\/run\.types/,
      /types\/task\.types/,
    ];

    for (const file of allFiles) {
      const imports = extractImports(file);
      for (const { line, module } of imports) {
        const isDeprecated = legacyPatterns.some((pattern) =>
          pattern.test(module),
        );
        if (isDeprecated) {
          violations.push({
            file,
            line,
            importedModule: module,
            reason: "Legacy modules should not be imported",
          });
        }
      }
    }

    expect(
      violations,
      `No code should import from legacy modules. Violations:\n${violations.map((v) => `${v.file}:${v.line} imports ${v.importedModule}`).join("\n")}`,
    ).toEqual([]);
  });

  it("should delete transitional core wrapper directories", () => {
    const deletedWrapperDirs = [
      "core/engine",
      "core/orchestration",
      "core/run",
      "core/task",
      "core/planner",
      "core/cost",
      "core/llm",
      "core/agents",
    ];

    for (const dir of deletedWrapperDirs) {
      const dirPath = path.join(BRAIN_SRC, dir);
      expect(
        fs.existsSync(dirPath),
        `${dir} should be removed after wrapper migration`,
      ).toBe(false);
    }
  });

  it("should not import transitional core wrapper paths", () => {
    const allFiles = getAllTSFiles(BRAIN_SRC, ["architecture", "core"]);
    const violations: DeprecatedImport[] = [];
    const wrapperImportPattern = /\/core\/(engine|orchestration|run|task|planner|cost|llm|agents)(\/|$)/;
    const multilineWrapperImportPattern =
      /import[\s\S]*?from\s+["']([^"']*\/core\/(engine|orchestration|run|task|planner|cost|llm|agents)(?:\/|$)[^"']*)["']/g;

    for (const file of allFiles) {
      const imports = extractImports(file);
      let hasWrapperImport = false;
      for (const { line, module } of imports) {
        if (wrapperImportPattern.test(module)) {
          hasWrapperImport = true;
          violations.push({
            file,
            line,
            importedModule: module,
            reason: "Imports must target @legioncode/execution-engine directly",
          });
        }
      }

      if (!hasWrapperImport) {
        const content = fs.readFileSync(file, "utf-8");
        let match: RegExpExecArray | null;
        while ((match = multilineWrapperImportPattern.exec(content)) !== null) {
          const line = estimateLineNumber(content, match.index);
          violations.push({
            file,
            line,
            importedModule: match[1],
            reason: "Imports must target @legioncode/execution-engine directly",
          });
        }
      }
    }

    expect(
      violations,
      `No transitional core wrapper imports are allowed. Violations:\n${violations.map((v) => `${v.file}:${v.line} imports ${v.importedModule}`).join("\n")}`,
    ).toEqual([]);
  });

  it("should not have orphaned orchestrator files", () => {
    const orchestratorPath = path.join(BRAIN_SRC, "orchestrator");
    const exists = fs.existsSync(orchestratorPath);

    if (exists) {
      const files = fs
        .readdirSync(orchestratorPath)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      expect(
        files.length,
        "orchestrator directory should be empty or deleted",
      ).toBe(0);
    }
  });

  it("should not have any references to deprecated @legioncode/brain internal exports", () => {
    const allFiles = getAllTSFiles(BRAIN_SRC, ["architecture"]);
    const violations: DeprecatedImport[] = [];

    // These patterns indicate imports from deprecated/removed code
    // Note: extractImports returns just the module path (e.g., "../deprecated/foo", "@legioncode/brain/legacy")
    // so patterns match against the module specifier, not the full import line
    const deprecatedExportPatterns = [
      /@legioncode\/brain\/legacy/,
      /\/deprecated\b/, // Matches paths like "../deprecated/foo" or "./deprecated/..."
    ];

    for (const file of allFiles) {
      const imports = extractImports(file);
      for (const { line, module } of imports) {
        const isDeprecatedExport = deprecatedExportPatterns.some((pattern) =>
          pattern.test(module),
        );
        if (isDeprecatedExport) {
          violations.push({
            file,
            line,
            importedModule: module,
            reason: "Should not import from deprecated exports",
          });
        }
      }
    }

    expect(
      violations,
      `No deprecated exports should be imported. Violations:\n${violations.map((v) => `${v.file}:${v.line} imports ${v.importedModule}`).join("\n")}`,
    ).toEqual([]);
  });

  it("should enforce zero re-export wrappers in core directory", () => {
    const coreDir = path.join(BRAIN_SRC, "core");
    if (!fs.existsSync(coreDir)) {
      return;
    }

    const approvedAllowlist = new Set<string>([
      "security/LogSanitizer.ts",
    ]);
    const files = getAllTSFiles(coreDir);
    const reExportViolations: string[] = [];

    for (const filePath of files) {
      const relativePath = path.relative(coreDir, filePath).replace(/\\/g, "/");
      if (approvedAllowlist.has(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const hasReExport =
        /export\s+(?:type\s+)?\*\s+from\s+["']/.test(content) ||
        /export\s+(?:type\s+)?\{[^}]+\}\s+from\s+["']/.test(content);

      if (hasReExport) {
        reExportViolations.push(relativePath);
      }
    }

    expect(
      reExportViolations,
      `Re-export wrappers are forbidden in core/*. Found:\n${reExportViolations.map((file) => `  ${file}`).join("\n")}`,
    ).toEqual([]);
  });
});

function estimateLineNumber(content: string, index: number): number {
  if (index <= 0) {
    return 1;
  }
  return content.slice(0, index).split("\n").length;
}
