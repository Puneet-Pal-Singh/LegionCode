import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  durableObjectConfiguration,
  hasLocalHyperdriveConfiguration,
  hasWorkerIdentityParity,
  readJsonc,
} from "../../../scripts/local-dev/local-wrangler-config.mjs";

const brainDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** @typedef {{ canonical: string, local: string }} LocalWranglerConfigPaths */

export const LOCAL_WRANGLER_CONFIG_REMEDIATION =
  "Brain local development is blocked: reconcile apps/brain/wrangler.local.jsonc with the tracked wrangler.jsonc names and service bindings. If it is absent, copy wrangler.local.example.jsonc first; preserve private Hyperdrive settings, Durable Object bindings, and migrations.";

/** @type {LocalWranglerConfigPaths} */
export const defaultLocalWranglerConfigPaths = {
  canonical: path.join(brainDir, "wrangler.jsonc"),
  local: path.join(brainDir, "wrangler.local.jsonc"),
};

/** @param {LocalWranglerConfigPaths} paths */
export function validateLocalWranglerConfig(
  paths = defaultLocalWranglerConfigPaths,
) {
  try {
    const canonicalConfig = readJsonc(paths.canonical);
    const localConfig = readJsonc(paths.local);

    return (
      hasWorkerIdentityParity(canonicalConfig, localConfig) &&
      hasLocalHyperdriveConfiguration(localConfig) &&
      JSON.stringify(durableObjectConfiguration(localConfig)) ===
        JSON.stringify(durableObjectConfiguration(canonicalConfig))
    );
  } catch {
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const explicitPaths =
    process.argv[2] && process.argv[3]
      ? { canonical: process.argv[2], local: process.argv[3] }
      : defaultLocalWranglerConfigPaths;
  if (!validateLocalWranglerConfig(explicitPaths)) {
    console.error(LOCAL_WRANGLER_CONFIG_REMEDIATION);
    process.exitCode = 1;
  }
}
