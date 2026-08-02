import path from "node:path";
import type { RunEngineOptions } from "./RunEngineTypes.js";

const CHECKOUT_ROOT_PREFIX = "/home/sandbox/checkouts/";

export interface LegacyRunExecutionScope {
  workspaceRoot: string;
  artifactRoot: string;
}

/**
 * Fails the quarantined direct RunEngine path closed when a server-issued
 * checkout scope was not injected. It must never synthesize a root from runId.
 */
export function requireLegacyRunExecutionScope(
  options: RunEngineOptions,
): LegacyRunExecutionScope {
  const workspaceRoot = validateCheckoutPath(
    options.workspaceRoot,
    "workspaceRoot",
  );
  const artifactRoot = validateCheckoutPath(
    options.artifactRoot,
    "artifactRoot",
  );
  if (
    artifactRoot !== `${workspaceRoot}/artifacts` &&
    !artifactRoot.startsWith(`${workspaceRoot}/artifacts/`)
  ) {
    throw new Error(
      "Legacy RunEngine artifactRoot must be scoped beneath the server-issued checkout",
    );
  }
  return { workspaceRoot, artifactRoot };
}

function validateCheckoutPath(
  value: string | undefined,
  label: string,
): string {
  if (
    !value ||
    value.includes("\0") ||
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    !value.startsWith(CHECKOUT_ROOT_PREFIX)
  ) {
    throw new Error(
      `Legacy RunEngine ${label} requires a server-issued task checkout`,
    );
  }
  return value;
}
