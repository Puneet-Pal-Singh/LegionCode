import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERAL_PR_METADATA_FIELDS,
  LIFECYCLE_METADATA_FIELDS,
  LIFECYCLE_SENSITIVE_PATHS,
  MIGRATION_SENSITIVE_PATHS,
  REBUILD_FLAG_REGISTRY,
} from "./rebuild-governance-policy.mjs";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const ENV_FLAG_PATTERN = /\bFEATURE_FLAG_[A-Z0-9_]+\b/g;

export async function validateRebuildGovernance(root, options = {}) {
  const violations = [];
  await validateFeatureFlags(root, violations);
  validateFeatureFlagPolicy(violations);
  validateChangedPathGovernance(options.changedFiles ?? [], violations);
  if (options.prBody !== undefined) {
    validatePullRequestMetadata(options, violations);
  }
  return violations;
}

export async function validateFeatureFlags(root, violations) {
  const files = await listSourceFiles(
    join(root, "apps"),
    join(root, "packages"),
    join(root, "scripts"),
    join(root, ".github"),
  );
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const flagName of findFeatureFlags(source)) {
      if (!REBUILD_FLAG_REGISTRY[flagName]) {
        violations.push(
          `${relative(root, file)}: ${flagName} is not registered in rebuild governance policy.`,
        );
      }
    }
  }
}

export function validateFeatureFlagPolicy(violations) {
  for (const [flagName, metadata] of Object.entries(REBUILD_FLAG_REGISTRY)) {
    validateFeatureFlagMetadata(flagName, metadata, violations);
  }
}

export function validateFeatureFlagMetadata(flagName, metadata, violations) {
  if (!metadata.owner) {
    violations.push(`${flagName}: feature flag owner is required.`);
  }
  if (metadata.temporary && !metadata.deletionCriteria) {
    violations.push(
      `${flagName}: temporary feature flags require deletion criteria.`,
    );
  }
}

export function validatePullRequestMetadata(options, violations) {
  const body = normalizeText(options.prBody ?? "");
  const missingGeneral = missingFields(body, GENERAL_PR_METADATA_FIELDS);
  if (missingGeneral.length > 0 && options.metadataMode === "blocking") {
    violations.push(formatMissingMetadata("PR metadata", missingGeneral));
  }
  if (!hasLifecycleSensitiveChange(options.changedFiles ?? [])) {
    return;
  }
  const missingLifecycle = missingFields(body, LIFECYCLE_METADATA_FIELDS);
  if (missingLifecycle.length > 0) {
    violations.push(
      formatMissingMetadata("Lifecycle metadata", missingLifecycle),
    );
  }
}

export function validateChangedPathGovernance(changedFiles, violations) {
  if (!hasMigrationSensitiveChange(changedFiles)) {
    return;
  }
  const hasMigrationTestChange = changedFiles.some((file) =>
    /packages\/persistence\/src\/.*(?:migration|MigrationRunner).*\.test\.ts$/.test(
      file,
    ),
  );
  if (!hasMigrationTestChange) {
    violations.push(
      "Persistence migration changes require a matching migration safety test update.",
    );
  }
}

export function hasLifecycleSensitiveChange(changedFiles) {
  return changedFiles.some((file) =>
    LIFECYCLE_SENSITIVE_PATHS.some((pattern) => pattern.test(file)),
  );
}

export function hasMigrationSensitiveChange(changedFiles) {
  return changedFiles.some((file) =>
    MIGRATION_SENSITIVE_PATHS.some((pattern) => pattern.test(file)),
  );
}

export function findFeatureFlags(source) {
  return [...new Set(source.match(ENV_FLAG_PATTERN) ?? [])].sort();
}

async function listSourceFiles(...roots) {
  const files = [];
  for (const root of roots) {
    await collectSourceFiles(root, files);
  }
  return files;
}

async function collectSourceFiles(root, files) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (isIgnoredEntry(entry.name)) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(path, files);
    } else if (SOURCE_EXTENSIONS.has(extension(entry.name))) {
      files.push(path);
    }
  }
}

function isIgnoredEntry(name) {
  return (
    name === "dist" ||
    name === "node_modules" ||
    name === ".wrangler" ||
    name.endsWith(".d.ts") ||
    /\.timestamp-\d+-[a-f0-9]+\.mjs$/.test(name)
  );
}

function extension(fileName) {
  return fileName.slice(fileName.lastIndexOf("."));
}

function missingFields(body, fields) {
  return fields.filter((field) => !body.includes(field));
}

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, " ");
}

function formatMissingMetadata(label, missing) {
  return `${label} is missing required field(s): ${missing.join(", ")}.`;
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const violations = await validateRebuildGovernance(root, {
    changedFiles: readChangedFilesFromEnv(),
    metadataMode: process.env.REBUILD_PR_METADATA_MODE ?? "report-only",
    prBody: process.env.REBUILD_PR_BODY,
  });
  reportViolations(violations);
}

function readChangedFilesFromEnv() {
  const raw = process.env.REBUILD_CHANGED_FILES;
  return raw ? raw.split("\n").filter(Boolean) : [];
}

function reportViolations(violations) {
  if (violations.length === 0) {
    console.log("OK: Rebuild governance policy is valid.");
    return;
  }
  console.error("ERROR: Rebuild governance policy failed:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
