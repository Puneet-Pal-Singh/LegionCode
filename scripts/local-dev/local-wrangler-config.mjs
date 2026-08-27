import { readFileSync } from "node:fs";

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
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      withoutComments += character;
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n")
        index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      index += 1;
      while (
        index + 1 < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      )
        index += 1;
      index += 1;
      continue;
    }
    withoutComments += character;
  }

  let result = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (
      character === "," &&
      /^\s*[}\]]/.test(withoutComments.slice(index + 1))
    ) {
      continue;
    }
    result += character;
  }
  return result;
}

/** @param {string} filePath */
export function readJsonc(filePath) {
  return JSON.parse(
    stripJsonCommentsAndTrailingCommas(readFileSync(filePath, "utf8")),
  );
}

/** @param {unknown} config */
function workerIdentity(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const root = /** @type {Record<string, unknown>} */ (config);
  if (typeof root.name !== "string" || root.name.trim().length === 0)
    return null;
  if (!Array.isArray(root.services) || root.services.length === 0) return null;

  const bindings = [];
  const seenBindings = new Set();
  const seenServices = new Set();
  for (const entry of root.services) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const service = /** @type {Record<string, unknown>} */ (entry);
    if (
      typeof service.binding !== "string" ||
      service.binding.trim().length === 0 ||
      typeof service.service !== "string" ||
      service.service.trim().length === 0 ||
      seenBindings.has(service.binding) ||
      seenServices.has(service.service)
    )
      return null;
    seenBindings.add(service.binding);
    seenServices.add(service.service);
    bindings.push({ binding: service.binding, service: service.service });
  }

  return {
    name: root.name,
    services: bindings.sort((left, right) =>
      left.binding.localeCompare(right.binding),
    ),
  };
}

/** @param {unknown} canonicalConfig @param {unknown} localConfig */
export function hasWorkerIdentityParity(canonicalConfig, localConfig) {
  const canonical = workerIdentity(canonicalConfig);
  const local = workerIdentity(localConfig);
  return (
    canonical !== null &&
    local !== null &&
    JSON.stringify(canonical) === JSON.stringify(local)
  );
}

/** @param {unknown} config */
export function durableObjectConfiguration(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config))
    return {};
  const root = /** @type {Record<string, unknown>} */ (config);
  return sortObjectKeys({
    bindings: root.durable_objects?.bindings ?? [],
    migrations: root.migrations ?? [],
  });
}

/** @param {unknown} value */
function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
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
export function hasLocalHyperdriveConfiguration(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config))
    return false;
  const root = /** @type {Record<string, unknown>} */ (config);
  if (!Array.isArray(root.hyperdrive)) return false;
  return root.hyperdrive.some(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      entry.binding === "HYPERDRIVE" &&
      typeof entry.localConnectionString === "string" &&
      entry.localConnectionString.trim().length > 0,
  );
}
