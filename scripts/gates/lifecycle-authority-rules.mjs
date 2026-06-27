import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const LIFECYCLE_AUTHORITY_RULES = [
  {
    kind: "file_absent",
    path: "apps/web/src/services/workflow/RunTerminalViewModel.ts",
    message: "legacy Web terminal status synthesizer must stay deleted",
  },
  {
    kind: "token_absent",
    path: "apps/brain/src/controllers/RunController.ts",
    token: "fetchRunSummaryFromRuntimeBestEffort",
    message: "Brain run summary must not best-effort overlay runtime state",
  },
  {
    kind: "token_absent",
    path: "apps/brain/src/controllers/RunController.ts",
    token: "mergeRunSummary",
    message: "Brain run summary must have one persisted projection authority",
  },
  {
    kind: "token_absent",
    path: "apps/web/src",
    token: "buildRunTerminalViewModel",
    message: "Web terminal cards must come from canonical lifecycle projection",
  },
  {
    kind: "token_absent",
    path: "apps/web/src",
    token: "live_git_empty_fallback",
    message: "review source selection must not silently fallback to saved edits",
  },
];

export function findLifecycleAuthorityViolations(projectRoot) {
  return LIFECYCLE_AUTHORITY_RULES.flatMap((rule) =>
    findRuleViolations(projectRoot, rule),
  );
}

function findRuleViolations(projectRoot, rule) {
  const absolutePath = join(projectRoot, rule.path);
  if (rule.kind === "file_absent") {
    return existsSync(absolutePath) ? [formatViolation(projectRoot, rule)] : [];
  }

  if (!existsSync(absolutePath)) {
    return [];
  }

  const files = listScannableFiles(absolutePath);
  return files
    .filter((file) => readFileSync(file, "utf8").includes(rule.token))
    .map((file) => formatViolation(projectRoot, rule, file));
}

function listScannableFiles(path) {
  if (!existsSync(path)) {
    return [];
  }

  const stat = statSync(path);
  if (stat.isFile()) {
    return isSourceFile(path) ? [path] : [];
  }

  return listDirectoryFiles(path).filter(isSourceFile);
}

function listDirectoryFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? listDirectoryFiles(child) : [child];
  });
}

function isSourceFile(path) {
  return /\.(ts|tsx|js|jsx|mjs)$/.test(path);
}

function formatViolation(projectRoot, rule, file = join(projectRoot, rule.path)) {
  return `${relative(projectRoot, file)}: ${rule.message}`;
}
