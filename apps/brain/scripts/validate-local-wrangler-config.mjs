import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const brainDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** @typedef {{ canonical: string, local: string }} LocalWranglerConfigPaths */

export const LOCAL_WRANGLER_CONFIG_REMEDIATION =
  "Brain local development is blocked: copy apps/brain/wrangler.local.example.jsonc to apps/brain/wrangler.local.jsonc and keep its Durable Object bindings and migrations unchanged.";

/** @type {LocalWranglerConfigPaths} */
export const defaultLocalWranglerConfigPaths = {
  canonical: path.join(brainDir, "wrangler.jsonc"),
  local: path.join(brainDir, "wrangler.local.jsonc"),
};

/** @param {string} source */
function stripJsonCommentsAndTrailingCommas(source) {
  let withoutComments = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (inString) {
      withoutComments += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      withoutComments += character;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      index += 1;
      while (
        index + 1 < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      continue;
    }

    withoutComments += character;
  }

  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;

  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];

    if (inString) {
      withoutTrailingCommas += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      withoutTrailingCommas += character;
      continue;
    }

    if (character === ",") {
      const remainder = withoutComments.slice(index + 1);
      if (/^\s*[}\]]/.test(remainder)) {
        continue;
      }
    }

    withoutTrailingCommas += character;
  }

  return withoutTrailingCommas;
}

/** @param {string} filePath */
function readJsonc(filePath) {
  return JSON.parse(
    stripJsonCommentsAndTrailingCommas(readFileSync(filePath, "utf8")),
  );
}

/** @param {unknown} value */
function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortObjectKeys(entry)]),
    );
  }
  return value;
}

/** @param {unknown} config */
export function durableObjectConfiguration(config) {
  const root =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? config
      : {};

  return sortObjectKeys({
    bindings: root.durable_objects?.bindings ?? [],
    migrations: root.migrations ?? [],
  });
}

/** @param {LocalWranglerConfigPaths} paths */
export function validateLocalWranglerConfig(
  paths = defaultLocalWranglerConfigPaths,
) {
  try {
    const canonicalConfig = readJsonc(paths.canonical);
    const localConfig = readJsonc(paths.local);

    return (
      JSON.stringify(durableObjectConfiguration(localConfig)) ===
      JSON.stringify(durableObjectConfiguration(canonicalConfig))
    );
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!validateLocalWranglerConfig()) {
    console.error(LOCAL_WRANGLER_CONFIG_REMEDIATION);
    process.exitCode = 1;
  }
}
