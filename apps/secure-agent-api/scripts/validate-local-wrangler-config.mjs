import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasWorkerIdentityParity,
  readJsonc,
} from "../../../scripts/local-dev/local-wrangler-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const localConfigPath = path.join(appDirectory, "wrangler.local.jsonc");
const defaultConfigPath = path.join(appDirectory, "wrangler.jsonc");
export const LOCAL_WRANGLER_CONFIG_REMEDIATION =
  "Secure runtime local development is blocked: reconcile wrangler.local.jsonc with the tracked Wrangler config names and service bindings while preserving private options.";

/** @typedef {{ canonical: string, local: string }} SecureRuntimeConfigPaths */

export function validateSecureRuntimeLocalCapacity(
  paths = { canonical: defaultConfigPath, local: localConfigPath },
) {
  let canonicalConfig;
  let localConfig;
  try {
    canonicalConfig = readJsonc(paths.canonical);
    localConfig = readJsonc(paths.local);
  } catch (error) {
    throw new Error(LOCAL_WRANGLER_CONFIG_REMEDIATION, { cause: error });
  }

  if (!hasWorkerIdentityParity(canonicalConfig, localConfig)) {
    throw new Error(LOCAL_WRANGLER_CONFIG_REMEDIATION);
  }

  const localCapacity = readCapacity(paths.local, "local secure runtime");
  const defaultCapacity = readCapacity(
    paths.canonical,
    "default secure runtime",
  );

  if (localCapacity !== defaultCapacity) {
    throw new Error(
      `Secure runtime local max_instances (${localCapacity}) must match the canonical default (${defaultCapacity}). Update apps/secure-agent-api/wrangler.local.jsonc before starting local workers.`,
    );
  }
  if (localCapacity < 2) {
    throw new Error(
      `Secure runtime local max_instances must allow parallel runs; received ${localCapacity}.`,
    );
  }

  return localCapacity;
}

function readCapacity(configPath, label) {
  let source;
  try {
    source = readFileSync(configPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} config at ${configPath}.`, {
      cause: error,
    });
  }
  const match = source.match(/"max_instances"\s*:\s*(\d+)/);
  const capacity = Number(match?.[1]);

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(
      `${label} containers[0].max_instances must be a positive integer.`,
    );
  }
  return capacity;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const capacity = validateSecureRuntimeLocalCapacity();
    console.log(
      `[secure-runtime/dev] local parallel capacity verified: ${capacity}`,
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : LOCAL_WRANGLER_CONFIG_REMEDIATION,
    );
    process.exitCode = 1;
  }
}
