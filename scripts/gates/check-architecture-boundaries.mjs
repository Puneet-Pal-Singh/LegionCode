import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_IMPORT_POLICY,
  CANONICAL_AUTHORITIES,
  PACKAGE_DEPENDENCY_POLICY,
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
    name === "dist" ||
    name === "node_modules" ||
    /\.timestamp-\d+-[a-f0-9]+\.mjs$/.test(name)
  );
}

function findRepoImports(source) {
  return [...source.matchAll(REPO_IMPORT_PATTERN)].map((match) => match[1]);
}

function findImportSpecifiers(source) {
  return [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].map(
    (match) => match[1],
  );
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
