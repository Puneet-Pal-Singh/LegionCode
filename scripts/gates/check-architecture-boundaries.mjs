import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_IMPORT_POLICY,
  CANONICAL_AUTHORITIES,
  DIRECT_GIT_COMMAND_POLICY,
  HARNESS_PRODUCT_PATH_GUARDS,
  PACKAGE_DEPENDENCY_POLICY,
  POLICY_INVENTORY_ALLOWED_CATEGORIES,
  POLICY_INVENTORY_ALLOWED_DISPOSITIONS,
  POLICY_INVENTORY_PATH,
  UNIQUE_ACTION_REGISTRIES,
} from "./architecture-policy.mjs";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const REPO_IMPORT_PATTERN =
  /(?:from\s+|import\s*\(|require\s*\()\s*["'](@repo\/[^/"']+)(?:\/[^"']*)?["']/g;
const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

export async function validateArchitecture(root) {
  const violations = [];
  await validatePackageDependencies(root, violations);
  await validateAppImports(root, violations);
  await validateCanonicalAuthorities(root, violations);
  await validateUniqueActionRegistries(root, violations);
  await validateDirectGitCommands(root, violations);
  await validatePolicyInventory(root, violations);
  await validateHarnessProductPathGuards(root, violations);
  return violations;
}

async function validatePackageDependencies(root, violations) {
  for (const [packageName, allowedDependencies] of Object.entries(
    PACKAGE_DEPENDENCY_POLICY,
  )) {
    const packageRoot = await findPackageRoot(root, "packages", packageName);
    const manifest = await readJson(join(packageRoot, "package.json"));
    const internalDependencies = Object.keys(
      manifest.dependencies ?? {},
    ).filter((name) => name.startsWith("@repo/"));

    for (const dependency of internalDependencies) {
      if (!allowedDependencies.includes(dependency)) {
        violations.push(
          `${relative(root, join(packageRoot, "package.json"))}: ${packageName} must not depend on ${dependency}; canonical dependencies: ${allowedDependencies.join(", ") || "none"}.`,
        );
      }
    }
  }
}

async function validateAppImports(root, violations) {
  for (const [appName, allowedImports] of Object.entries(APP_IMPORT_POLICY)) {
    const appRoot = await findPackageRoot(root, "apps", appName);
    for (const file of await listSourceFiles(appRoot)) {
      const source = await readFile(file, "utf8");
      if (findImportSpecifiers(source).some(isDeepPackageSourceImport)) {
        violations.push(
          `${relative(root, file)}: apps must import packages through public package exports.`,
        );
      }

      for (const importedPackage of findRepoImports(source)) {
        if (!allowedImports.includes(importedPackage)) {
          violations.push(
            `${relative(root, file)}: ${appName} must not import ${importedPackage}; allowed canonical imports: ${allowedImports.join(", ") || "none"}.`,
          );
        }
      }
    }
  }
}

async function validateCanonicalAuthorities(root, violations) {
  const sourceFiles = await listSourceFiles(
    join(root, "apps"),
    join(root, "packages"),
  );
  for (const authority of CANONICAL_AUTHORITIES) {
    for (const file of sourceFiles) {
      const source = await readFile(file, "utf8");
      const path = relative(root, file);
      if (authority.declaration.test(source) && path !== authority.owner) {
        violations.push(
          `${path}: ${authority.symbol} is owned by ${authority.owner}; competing authority declarations are forbidden.`,
        );
      }
    }
  }
}

async function validateUniqueActionRegistries(root, violations) {
  for (const registry of UNIQUE_ACTION_REGISTRIES) {
    const source = await readFile(join(root, registry.path), "utf8");
    const duplicateNames = findDuplicateMatches(source, registry.pattern);
    for (const duplicateName of duplicateNames) {
      violations.push(
        `${registry.path}: ${registry.name} must not declare duplicate action name ${duplicateName}.`,
      );
    }
  }
}

async function validateDirectGitCommands(root, violations) {
  for (const policy of DIRECT_GIT_COMMAND_POLICY) {
    const source = await readFile(join(root, policy.path), "utf8");
    const directGitCommands = findDirectGitCommandSnippets(source);
    for (const snippet of directGitCommands) {
      if (!policy.allowedPatterns.some((pattern) => pattern.test(snippet))) {
        violations.push(
          `${policy.path}: direct git command is forbidden outside the documented adapter exceptions; route Git semantics through @repo/git-service.`,
        );
      }
    }
  }
}

async function validatePolicyInventory(root, violations) {
  const inventory = await readPolicyInventory(root);
  const entries = inventory.entries ?? [];
  const inventoryPaths = new Set();

  for (const entry of entries) {
    validatePolicyInventoryEntry(root, entry, inventoryPaths, violations);
  }

  const policyFiles = (await listSourceFiles(join(root, "apps"), join(root, "packages")))
    .map((file) => relative(root, file))
    .filter((path) => path.endsWith("Policy.ts"))
    .sort();

  for (const policyFile of policyFiles) {
    if (!inventoryPaths.has(policyFile)) {
      violations.push(
        `${policyFile}: policy file is missing from ${POLICY_INVENTORY_PATH}; classify it before adding behavior.`,
      );
    }
  }

  for (const inventoryPath of inventoryPaths) {
    if (!policyFiles.includes(inventoryPath)) {
      violations.push(
        `${POLICY_INVENTORY_PATH}: inventory references missing policy file ${inventoryPath}.`,
      );
    }
  }
}

async function readPolicyInventory(root) {
  const inventory = await readJson(join(root, POLICY_INVENTORY_PATH));
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) {
    throw new Error(`${POLICY_INVENTORY_PATH} must contain a JSON object.`);
  }
  if (!Array.isArray(inventory.entries)) {
    throw new Error(`${POLICY_INVENTORY_PATH} must contain an entries array.`);
  }
  return inventory;
}

function validatePolicyInventoryEntry(root, entry, seenPaths, violations) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    violations.push(`${POLICY_INVENTORY_PATH}: each entry must be an object.`);
    return;
  }

  const path = readInventoryString(entry.path);
  if (!path) {
    violations.push(`${POLICY_INVENTORY_PATH}: entry is missing path.`);
    return;
  }
  if (seenPaths.has(path)) {
    violations.push(`${POLICY_INVENTORY_PATH}: duplicate inventory entry ${path}.`);
  }
  seenPaths.add(path);

  if (resolve(root, path) !== join(root, path)) {
    violations.push(
      `${POLICY_INVENTORY_PATH}: ${path} must be a repo-relative path without traversal.`,
    );
  }
  if (!path.endsWith("Policy.ts")) {
    violations.push(`${POLICY_INVENTORY_PATH}: ${path} must end in Policy.ts.`);
  }

  const category = readInventoryString(entry.category);
  if (!POLICY_INVENTORY_ALLOWED_CATEGORIES.includes(category)) {
    violations.push(
      `${POLICY_INVENTORY_PATH}: ${path} has invalid category ${category || "(missing)"}.`,
    );
  }

  const disposition = readInventoryString(entry.disposition);
  if (!POLICY_INVENTORY_ALLOWED_DISPOSITIONS.includes(disposition)) {
    violations.push(
      `${POLICY_INVENTORY_PATH}: ${path} has invalid disposition ${disposition || "(missing)"}.`,
    );
  }

  for (const field of ["owner", "purpose", "gate"]) {
    if (!readInventoryString(entry[field])) {
      violations.push(`${POLICY_INVENTORY_PATH}: ${path} is missing ${field}.`);
    }
  }

  if (
    (disposition === "delete-from-product-path" ||
      disposition === "quarantine-temporarily") &&
    !readInventoryString(entry.deletionTrigger)
  ) {
    violations.push(
      `${POLICY_INVENTORY_PATH}: ${path} must document a deletionTrigger for ${disposition}.`,
    );
  }
}

async function validateHarnessProductPathGuards(root, violations) {
  const sourceFiles = await listSourceFiles(join(root, "apps"), join(root, "packages"));
  await validateTurnModePolicyImports(root, sourceFiles, violations);
  await validateFinalAnswerRegexRepair(root, sourceFiles, violations);
  await validateDuplicateToolRegistries(root, sourceFiles, violations);
}

async function validateTurnModePolicyImports(root, sourceFiles, violations) {
  const guard = HARNESS_PRODUCT_PATH_GUARDS.turnModePolicy;
  for (const file of sourceFiles) {
    const path = relative(root, file);
    if (isTestSourcePath(path) || guard.allowedFiles.includes(path)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (guard.forbiddenImportPattern.test(source)) {
      violations.push(
        `${path}: production code must not import RunTurnModePolicy for product routing; use capability manifest, tool registry, permission policy, and evidence-backed settlement.`,
      );
    }
  }
}

async function validateFinalAnswerRegexRepair(root, sourceFiles, violations) {
  const guard = HARNESS_PRODUCT_PATH_GUARDS.finalAnswerRegexRepair;
  const quarantinedPaths = new Set(
    guard.quarantinedFiles.map((entry) => entry.path),
  );

  for (const file of sourceFiles) {
    const path = relative(root, file);
    if (isTestSourcePath(path) || quarantinedPaths.has(path)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    for (const repairPattern of guard.patterns) {
      if (repairPattern.pattern.test(source)) {
        violations.push(
          `${path}: forbidden final-answer regex repair (${repairPattern.name}); final answers must come from typed model parts and terminal events.`,
        );
      }
    }
  }
}

async function validateDuplicateToolRegistries(root, sourceFiles, violations) {
  const guard = HARNESS_PRODUCT_PATH_GUARDS.duplicateToolRegistries;
  const allowedPaths = new Set([
    ...guard.canonicalFiles,
    ...guard.quarantinedFiles.map((entry) => entry.path),
  ]);

  for (const file of sourceFiles) {
    const path = relative(root, file);
    if (isTestSourcePath(path) || allowedPaths.has(path)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (guard.declarationPattern.test(source)) {
      violations.push(
        `${path}: duplicate tool registries are forbidden; tool visibility must flow through the canonical runtime registry/capability manifest.`,
      );
    }
  }
}

async function findPackageRoot(root, collection, packageName) {
  const collectionRoot = join(root, collection);
  for (const entry of await readdir(collectionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(collectionRoot, entry.name);
    const manifest = await readJson(join(candidate, "package.json"));
    if (manifest.name === packageName) {
      return candidate;
    }
  }
  throw new Error(
    `Architecture policy references missing package: ${packageName}`,
  );
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
    if (isIgnoredSourceEntry(entry.name)) {
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

function isIgnoredSourceEntry(name) {
  return (
    name === ".next" ||
    name === ".turbo" ||
    name === ".wrangler" ||
    name === "dist" ||
    name === "node_modules" ||
    name === "out" ||
    /\.timestamp-\d+-[a-f0-9]+\.mjs$/.test(name)
  );
}

function isTestSourcePath(path) {
  return (
    path.includes("/__tests__/") ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /\.spec\.[cm]?[jt]sx?$/.test(path)
  );
}

function readInventoryString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function findRepoImports(source) {
  return [...source.matchAll(REPO_IMPORT_PATTERN)].map((match) => match[1]);
}

function findImportSpecifiers(source) {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map(
    (match) => match[1],
  );
}

function findDuplicateMatches(source, pattern) {
  pattern.lastIndex = 0;
  const names = [...source.matchAll(pattern)].map((match) => match[1]);
  const seen = new Set();
  const duplicates = new Set();
  for (const name of names) {
    if (seen.has(name)) {
      duplicates.add(name);
    } else {
      seen.add(name);
    }
  }
  return [...duplicates].sort();
}

function findDirectGitCommandSnippets(source) {
  const snippets = [];
  const pattern = /command:\s*["']git["']/g;
  for (const match of source.matchAll(pattern)) {
    const start = Math.max(0, match.index - 160);
    const end = Math.min(source.length, match.index + 320);
    snippets.push(source.slice(start, end));
  }
  return snippets;
}

function isDeepPackageSourceImport(specifier) {
  return /(?:^|\/)packages\/[^/]+\/src\//.test(specifier);
}

function extension(fileName) {
  return fileName.slice(fileName.lastIndexOf("."));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const violations = await validateArchitecture(root);
  if (violations.length > 0) {
    console.error("ERROR: Architecture boundary check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "OK: Architecture boundaries and canonical authorities are valid.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
