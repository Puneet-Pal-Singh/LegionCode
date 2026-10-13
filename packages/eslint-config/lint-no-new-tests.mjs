import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tseslint from "typescript-eslint";

const root = process.cwd();
const recognizedModules = new Set([
  "vitest",
  "node:test",
  "@playwright/test",
  "jest",
  "@jest/globals",
]);
const testMethods = new Set([
  "each",
  "only",
  "skip",
  "concurrent",
  "serial",
  "fails",
  "todo",
  "skipIf",
  "runIf",
]);
const testFile =
  /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const sourceFile = /\.[cm]?[jt]sx?$/i;

function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitOutput(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function baselineRef() {
  if (process.env.GITHUB_ACTIONS === "true") {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const sha = event.pull_request?.base?.sha ?? event.before;
    if (!sha || /^0+$/.test(sha)) {
      throw new Error(
        "Cannot check test additions: CI event has no usable base commit.",
      );
    }
    try {
      git("cat-file", "-e", `${sha}^{commit}`);
    } catch {
      throw new Error(
        `Cannot check test additions: CI base commit ${sha} is unavailable.`,
      );
    }
    return sha;
  }

  try {
    git("show-ref", "--verify", "--quiet", "refs/remotes/origin/main");
    return git("merge-base", "HEAD", "origin/main");
  } catch {
    return git("rev-parse", "HEAD");
  }
}

function changedTestFiles(base) {
  const changed = gitOutput(
    "diff",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
    base,
    "--",
  )
    .split("\0")
    .filter(Boolean);
  const untracked = gitOutput(
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set([...changed, ...untracked])].filter(
    (path) => testFile.test(path) && sourceFile.test(path),
  );
}

function canonicalTests(source, filePath) {
  const { ast, visitorKeys } = tseslint.parser.parseForESLint(source, {
    filePath,
    loc: true,
    range: true,
    ecmaVersion: "latest",
    sourceType: "module",
  });
  const namedImports = new Map();
  const namespaceImports = new Set();
  const shadowedNames = new Set();

  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      shadowedNames.add(specifier.local.name);
      if (!recognizedModules.has(statement.source.value)) continue;
      if (specifier.type === "ImportSpecifier") {
        const imported = specifier.imported.name ?? specifier.imported.value;
        if (imported === "it" || imported === "test")
          namedImports.set(specifier.local.name, imported);
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        namespaceImports.add(specifier.local.name);
      } else if (statement.source.value === "node:test") {
        namedImports.set(specifier.local.name, "test");
      }
    }
  }

  const signatures = [];
  const textOf = (node) => {
    if (node.type === "Literal" && typeof node.value === "string")
      return JSON.stringify(node.value);
    return source
      .slice(node.range[0], node.range[1])
      .replace(/\s+/g, " ")
      .trim();
  };

  function chainOf(expression) {
    if (expression.type === "Identifier")
      return { root: expression.name, members: [], datasets: [] };
    if (expression.type === "MemberExpression" && !expression.computed) {
      const chain = chainOf(expression.object);
      if (!chain) return null;
      chain.members.push(expression.property.name);
      return chain;
    }
    if (
      expression.type === "MemberExpression" &&
      expression.computed &&
      expression.property.type === "Literal"
    ) {
      const chain = chainOf(expression.object);
      if (!chain) return null;
      chain.members.push(String(expression.property.value));
      return chain;
    }
    if (expression.type === "CallExpression") {
      const moduleName =
        expression.callee.type === "Identifier" &&
        expression.callee.name === "require"
          ? expression.arguments[0]?.value
          : null;
      if (typeof moduleName === "string" && recognizedModules.has(moduleName)) {
        const root = `__require:${moduleName}`;
        namespaceImports.add(root);
        if (moduleName === "node:test") namedImports.set(root, "test");
        return { root, members: [], datasets: [] };
      }
      const chain = chainOf(expression.callee);
      if (chain?.members.at(-1) === "each" && expression.arguments[0]) {
        chain.datasets.push(textOf(expression.arguments[0]));
      }
      return chain;
    }
    return null;
  }

  const requiredModule = (expression) => {
    if (
      expression?.type !== "CallExpression" ||
      expression.callee.type !== "Identifier" ||
      expression.callee.name !== "require"
    )
      return null;
    const moduleName = expression.arguments[0]?.value;
    return typeof moduleName === "string" && recognizedModules.has(moduleName)
      ? moduleName
      : null;
  };
  const bindingNames = (pattern) => {
    if (!pattern) return [];
    if (pattern.type === "Identifier") return [pattern.name];
    if (pattern.type === "ObjectPattern")
      return pattern.properties.flatMap((property) =>
        bindingNames(property.value ?? property.argument),
      );
    if (pattern.type === "ArrayPattern")
      return pattern.elements.flatMap((element) =>
        element ? bindingNames(element) : [],
      );
    if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
    return [];
  };

  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      for (const name of bindingNames(declaration.id)) shadowedNames.add(name);
      const moduleName = requiredModule(declaration.init);
      if (!moduleName) continue;
      if (declaration.id.type === "Identifier") {
        namespaceImports.add(declaration.id.name);
        if (moduleName === "node:test")
          namedImports.set(declaration.id.name, "test");
      }
      if (declaration.id.type === "ObjectPattern") {
        for (const property of declaration.id.properties) {
          if (property.type === "RestElement") continue;
          const imported = property.key.name ?? property.key.value;
          if (
            (imported === "it" || imported === "test") &&
            property.value.type === "Identifier"
          ) {
            namedImports.set(property.value.name, imported);
          }
        }
      }
    }
  }

  function visit(node) {
    const partialFactory =
      node.callee?.type === "MemberExpression" &&
      ["each", "skipIf", "runIf"].includes(
        node.callee.property.name ?? node.callee.property.value,
      );
    if (
      node.type === "CallExpression" &&
      node.arguments.length > 0 &&
      !partialFactory
    ) {
      const chain = chainOf(node.callee);
      const methods =
        chain && namespaceImports.has(chain.root)
          ? chain.members.slice(1)
          : chain?.members;
      if (chain && methods?.every((member) => testMethods.has(member))) {
        let api = namedImports.get(chain.root);
        if (
          !api &&
          namespaceImports.has(chain.root) &&
          ["it", "test"].includes(chain.members[0])
        ) {
          api = chain.members.shift();
        }
        if (
          !api &&
          !shadowedNames.has(chain.root) &&
          ["it", "test"].includes(chain.root)
        ) {
          api = chain.root;
        }
        if (api)
          signatures.push(
            `${api}:${chain.datasets.join(";")}:${textOf(node.arguments[0])}`,
          );
      }
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => child && visit(child));
      else if (value) visit(value);
    }
  }

  visit(ast);
  return signatures.sort();
}

function firstNewSignature(previous, current) {
  const counts = new Map();
  for (const signature of previous)
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  for (const signature of current) {
    const count = counts.get(signature) ?? 0;
    if (count === 0) return signature;
    counts.set(signature, count - 1);
  }
  return null;
}

const base = baselineRef();
const violations = [];
for (const file of changedTestFiles(base)) {
  let before;
  try {
    before = gitOutput("show", `${base}:${file}`);
  } catch {
    violations.push(`${file}: new test files are not allowed`);
    continue;
  }

  const after = readFileSync(resolve(root, file), "utf8");
  const added = firstNewSignature(
    canonicalTests(before, file),
    canonicalTests(after, file),
  );
  if (added) violations.push(`${file}: new test registration ${added}`);
}

if (violations.length) {
  console.error("Test additions are blocked by repository policy:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Test-addition guard passed.");
}
