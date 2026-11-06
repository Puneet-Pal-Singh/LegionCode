import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { HarnessHostError } from "./errors.js";

const inheritedNames = [
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Explicit selected-instance material comes from the existing credential authority. */
export function createInstanceEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  selected: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  if (!inherited.HOME || !isAbsolute(inherited.HOME))
    throw new HarnessHostError("invalid_launch");
  const result: Record<string, string> = Object.create(null);
  for (const name of inheritedNames) {
    const value = inherited[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(selected)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      inheritedNames.includes(name as (typeof inheritedNames)[number]) ||
      /^(?:NODE_OPTIONS|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|GIT_.*)$/.test(
        name,
      ) ||
      value.includes("\0")
    ) {
      throw new HarnessHostError("invalid_launch");
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

/** Resolve symlinks before accepting a launch cwd. This does not replace an OS sandbox. */
export async function resolveWorkspaceDirectory(
  root: string,
  cwd: string,
): Promise<string> {
  if (!isAbsolute(root) || !isAbsolute(cwd))
    throw new HarnessHostError("invalid_launch");
  const [resolvedRoot, resolvedCwd] = await Promise.all([
    realpath(root),
    realpath(cwd),
  ]);
  const child = relative(resolvedRoot, resolvedCwd);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new HarnessHostError("invalid_launch");
  return resolvedCwd;
}

/** Provider config/auth directories must be outside review/snapshot workspace roots. */
export async function resolveInstanceDirectory(
  workspaceRoot: string,
  instanceDirectory: string,
): Promise<string> {
  if (!isAbsolute(instanceDirectory))
    throw new HarnessHostError("invalid_launch");
  const [root, directory] = await Promise.all([
    realpath(workspaceRoot),
    realpath(instanceDirectory),
  ]);
  const child = relative(root, directory);
  if (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  ) {
    throw new HarnessHostError("invalid_launch");
  }
  return directory;
}
