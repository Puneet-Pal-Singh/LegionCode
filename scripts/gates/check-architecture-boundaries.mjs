import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
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
  /(?:from\s+|import\s*\(|require\s*\(|\bimport\s*)\s*["'](@repo\/[^/"']+)(?:\/[^"']*)?["']/g;
const IMPORT_SPECIFIER_PATTERN =
  /(?:from\s+|import\s*\(|require\s*\(|\bimport\s*)\s*["']([^"']+)["']/g;

export async function validateArchitecture(root) {
  const violations = [];
  await validatePackageDependencies(root, violations);
  await validateLocalPersistenceImports(root, violations);
  await validateSdkAppServerImports(root, violations);
  await validateHarnessImportBoundaries(root, violations);
  await validateAppImports(root, violations);
  await validateCanonicalAuthorities(root, violations);
  await validateUniqueActionRegistries(root, violations);
  await validateDirectGitCommands(root, violations);
  await validatePolicyInventory(root, violations);
  await validateHarnessProductPathGuards(root, violations);
  await validateClientSideTurnIdDerivation(root, violations);
  await validateActiveStateRunSummaryAuthority(root, violations);
  return violations;
}

async function validateLocalPersistenceImports(root, violations) {
  const sourceFiles = await listSourceFiles(join(root, "apps"), join(root, "packages"));
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    const path = relative(root, file);
    const runtimeSource = source.replace(
      /\bimport\s+type\s+[\s\S]*?\s+from\s+["'][^"']+["'];?/g,
      "",
    );
    const imports = findImportSpecifiers(runtimeSource);
    const isTest = isTestSourcePath(path);
    if (
      imports.includes("@repo/event-store/local") &&
      path !== "packages/app-server/src/local-process.ts" &&
      !isTest
    ) {
      violations.push(
        `${path}: local persistence is private to the local App Server process entry; native storage imports are forbidden from hosted App Server, protocol, SDK, renderer, and root barrels.`,
      );
    }
    if (imports.includes("better-sqlite3") && path !== "packages/event-store/src/local.ts" && !isTest) {
      violations.push(
        `${path}: better-sqlite3 is private to packages/event-store/src/local.ts; clients and hosted runtime may not load the native driver.`,
      );
    }
    if (
      path === "packages/event-store/src/index.ts" &&
      imports.some((specifier) => /^\.\/local(?:\.js)?$/.test(specifier))
    ) {
      violations.push(
        `${path}: local persistence must not be re-exported from the event-store root barrel.`,
      );
    }
    if (
      path === "packages/app-server/src/index.ts" &&
      imports.some((specifier) => /^\.\/local-process(?:\.js)?$/.test(specifier))
    ) {
      violations.push(
        `${path}: the App Server root barrel must not load the local process or its native persistence dependency.`,
      );
    }
  }
}

async function validateSdkAppServerImports(root, violations) {
  const sdkRoot = await findPackageRoot(root, "packages", "@legioncode/sdk");
  for (const file of await listSourceFiles(sdkRoot)) {
    const source = await readFile(file, "utf8");
    const path = relative(root, file);
    for (const specifier of findImportSpecifiers(source)) {
      // This existing Node HTTP contract test invokes the real request handler to
      // prove SDK wire validation and dispatch together. No production SDK file
      // or other test gains a server import exception.
      if (
        path === "packages/sdk/src/platform/app-server-client.test.ts" &&
        specifier === "@legioncode/app-server/server"
      ) continue;
      if (
        specifier.startsWith("@legioncode/app-server") &&
        specifier !== "@legioncode/app-server/protocol"
      ) {
        violations.push(
          `${relative(root, file)}: SDK may depend on App Server only through @legioncode/app-server/protocol; received ${specifier}.`,
        );
      }
    }
  }
}

// Concrete harnesses execute in Node. Client metadata and private bridge facts
// must stay usable by the browser and Workers, including through re-exports.
async function validateHarnessImportBoundaries(root, violations) {
  const sdkOwners = new Map([
    ["@anthropic-ai/claude-agent-sdk", "harness-claude"],
    ["@openai/codex", "harness-codex"],
    ["@openai/codex-sdk", "harness-codex"],
    ["@opencode/client", "harness-opencode"],
    ["@opencode/cli", "harness-opencode"],
  ]);
  for (const file of await listSourceFiles(
    join(root, "apps"),
    join(root, "packages"),
  )) {
    const path = relative(root, file);
    if (isTestSourcePath(path)) continue;
    const source = await readFile(file, "utf8");
    const owner =
      /^packages\/(harness-(?:core|codex|claude|opencode))\/src\//.exec(
        path,
      )?.[1];
    const isServer = Boolean(
      owner && new RegExp(`^packages/${owner}/src/server(?:\\.|/)`).test(path),
    );
    const isComposition =
      path === "packages/app-server/src/harness/LocalHarnessComposition.ts" ||
      path.startsWith("apps/secure-agent-api/harness-host/");
    // LocalTurnService is owned by the Node App Server composition. Its driver
    // annotations and configureHost type query erase at emit; runtime imports
    // still go through the same private-entry checks as every other consumer.
    // Keep this exact-file/type-only exception out of Worker and client graphs.
    const importSource =
      path === "packages/app-server/src/harness/LocalTurnService.ts"
        ? source
            .replace(
              /\bimport\s+type\s+[^;]*?\s+from\s+["']@repo\/harness-(?:core|codex|opencode)\/server["'];?/g,
              "",
            )
            .replace(
              /\bParameters<import\("@repo\/harness-core\/server"\)\.HarnessInstance\["createHost"\]>/g,
              "",
            )
        : source;
    for (const specifier of findImportSpecifiers(importSource)) {
      if (
        specifier === "@opencode-ai/sdk" ||
        specifier.startsWith("@opencode-ai/sdk/")
      ) {
        violations.push(
          `${path}: OpenCode v1 SDK imports are forbidden; the built-in harness uses the pinned native v2 @opencode/client.`,
        );
      }
      const importedHarness =
        /^@(?:repo|legioncode)\/(harness-(?:core|codex|claude|opencode))(?:\/(.*))?$/.exec(
          specifier,
        );
      if (importedHarness) {
        const [, importedOwner, entry] = importedHarness;
        const isPublic = entry === "client" || entry === "settings";
        const allowedServer =
          entry === "server" &&
          (isComposition ||
            (isServer &&
              (importedOwner === "harness-core" || importedOwner === owner)));
        if (!isPublic && !allowedServer) {
          violations.push(
            `${path}: ${specifier} is a private Node harness entry; concrete drivers belong only in local App Server/cloud Node composition, and clients use ./client or ./settings.`,
          );
        }
      }
      const sdk = [...sdkOwners.keys()].find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );
      if (sdk && !(isServer && owner === sdkOwners.get(sdk))) {
        violations.push(
          `${path}: ${sdk} is private to packages/${sdkOwners.get(sdk)}/src/server; Workers, SDK, browser and renderer must not load agent SDKs.`,
        );
      }
      if (owner && !isServer && isBuiltin(specifier)) {
        violations.push(
          `${path}: public harness metadata must not import Node module ${specifier}; keep Node code in ./server.`,
        );
      }
      if (!specifier.startsWith(".")) continue;
      const target = relative(root, resolve(dirname(file), specifier));
      if (
        /^packages\/harness-(?:core|codex|claude|opencode)\/src\/server(?:\.|\/)/.test(
          target,
        ) &&
        !(isServer && target.startsWith(`packages/${owner}/`))
      ) {
        violations.push(
          `${path}: relative imports/re-exports must not expose private harness server code; use the approved Node composition export.`,
        );
      }
      if (
        target.startsWith("apps/secure-agent-api/harness-host/") &&
        !path.startsWith("apps/secure-agent-api/harness-host/")
      ) {
        violations.push(
          `${path}: the cloud Node harness host must stay outside the Worker import graph; use worker-protocol bridge facts.`,
        );
      }
      if (
        /packages\/app-server\/src\/harness\/LocalHarnessComposition(?:\.|\/)/.test(
          target,
        ) &&
        path !== "packages/app-server/src/local-process.ts"
      ) {
        violations.push(
          `${path}: local harness composition is private to the local App Server process entry.`,
        );
      }
    }
  }
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
      // This separately built Node entry is not part of the secure-api Worker.
      // Its concrete driver imports are checked by validateHarnessImportBoundaries.
      if (appName === "@legioncode/secure-agent-api" && relative(appRoot, file).startsWith("harness-host/")) continue;
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
  await validatePromptIntentPolicyImports(root, sourceFiles, violations);
  await validatePromptTextRouting(root, sourceFiles, violations);
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
    if (
      guard.forbiddenImportPattern.test(source) ||
      guard.forbiddenReferencePattern.test(source)
    ) {
      violations.push(
        `${path}: production code must not use deleted turn-mode/direct-plan policy for product routing; use explicit turn metadata, capability policy, tool registry, and evidence-backed settlement.`,
      );
    }
  }
}

async function validatePromptIntentPolicyImports(root, sourceFiles, violations) {
  const guard = HARNESS_PRODUCT_PATH_GUARDS.promptIntentPolicy;
  for (const file of sourceFiles) {
    const path = relative(root, file);
    if (isTestSourcePath(path) || guard.allowedFiles.includes(path)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (
      guard.forbiddenImportPattern.test(source) ||
      guard.forbiddenReferencePattern.test(source)
    ) {
      violations.push(
        `${path}: production code must not use prompt intent classifiers for product routing; use explicit turn metadata, capability policy, tool registry, and evidence-backed settlement.`,
      );
    }
  }
}

async function validatePromptTextRouting(root, sourceFiles, violations) {
  const guard = HARNESS_PRODUCT_PATH_GUARDS.promptTextRouting;
  for (const file of sourceFiles) {
    const path = relative(root, file);
    if (isTestSourcePath(path)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (guard.forbiddenPattern.test(source)) {
      violations.push(
        `${path}: production code must not route product behavior from prompt text; use explicit turn metadata and capability/runtime context.`,
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

async function validateClientSideTurnIdDerivation(root, violations) {
  const guard = HARNESS_PRODUCT_PATH_GUARDS.clientSideTurnIdDerivation;
  const webRoot = join(root, "apps", "web", "src");
  const sourceFiles = await listSourceFiles(webRoot);

  for (const file of sourceFiles) {
    const path = relative(root, file);
    if (isTestSourcePath(path) || guard.allowedFiles.includes(path)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (guard.forbiddenImportPattern.test(source)) {
      violations.push(
        `${path}: Web product code must not derive turn identity client-side with turnIdFromRunId or turnSeedFromLatestUserMessage; use canonical server-provided turnId from the X-Turn-Id response header.`,
      );
    }
  }
}

async function validateActiveStateRunSummaryAuthority(root, violations) {
  const guard = HARNESS_PRODUCT_PATH_GUARDS.activeStateRunSummaryAuthority;
  const webRoot = join(root, "apps", "web", "src");
  const sourceFiles = await listSourceFiles(webRoot);

  for (const file of sourceFiles) {
    const path = relative(root, file);
    if (isTestSourcePath(path) || guard.allowedFiles.includes(path)) {
      continue;
    }
    const source = await readFile(file, "utf8");
    if (guard.forbiddenImportPattern.test(source)) {
      violations.push(
        `${path}: active Web chat components must not import run-summary status helpers for active-turn state; use canonical lifecycle projection for active workflow/thinking/approval/terminal state.`,
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
    let manifest;
    try {
      manifest = await readJson(join(candidate, "package.json"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        // Build tooling can leave ignored artifact directories behind after a
        // package is removed. They are not package roots and must not make the
        // architecture gate fail before it can validate the declared policy.
        continue;
      }
      throw error;
    }
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
    name === ".worktrees" ||
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
