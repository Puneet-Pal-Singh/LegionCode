import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Adapter failure code for runtime capability reporting; never infer support from a fallback. */
export class SingleProcessMacCapabilityError extends Error {
  readonly code = "single_executable_nofork_unavailable" as const;
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SingleProcessMacCapabilityError";
  }
}

/** Private runtime authority, never accepted from model/tool input. */
export type SingleProcessMacSandbox = {
  filesystemRoot: string;
  /** Trusted, explicitly declared read-only runtime/library directories. */
  runtimeReadRoots: readonly string[];
  network: "denied";
  writeScope: "workspace";
};

/** Deny-default scope. No general IPC, outside-workspace write or network grant. */
export function buildSingleProcessMacSandbox(
  executable: string,
  sandbox: SingleProcessMacSandbox,
): { profile: string; parameters: string[] } {
  const validPath = (path: string) => typeof path === "string" && isAbsolute(path)
    && resolve(path) !== "/" && !path.includes("\0") && Buffer.byteLength(path) <= 4_096;
  if (!sandbox || sandbox.network !== "denied" || sandbox.writeScope !== "workspace"
    || !validPath(sandbox.filesystemRoot) || !Array.isArray(sandbox.runtimeReadRoots)
    || sandbox.runtimeReadRoots.length > 32 || !sandbox.runtimeReadRoots.every(validPath) || !validPath(executable)) {
    throw new SingleProcessMacCapabilityError("Unsupported single-process sandbox authority");
  }
  // Accept only the canonical paths captured by the trusted grant/runtime
  // owner. An alias to / must never widen a declared subtree to the host.
  try {
    for (const path of [sandbox.filesystemRoot, ...sandbox.runtimeReadRoots]) {
      if (realpathSync(path) !== path) throw new SingleProcessMacCapabilityError("Sandbox authority paths must be canonical");
    }
  } catch (error) {
    if (error instanceof SingleProcessMacCapabilityError) throw error;
    throw new SingleProcessMacCapabilityError("Sandbox authority paths are unavailable", error);
  }
  const profile = [
    "(version 1)", "(deny default)", "(allow process-exec)", "(deny process-fork)",
    "(allow signal (target self))",
    // Codex's base policy permits process-info* for same-sandbox targets.
    // No-fork execution needs only its own runtime/code-signing metadata.
    "(allow process-info* (target self))",
    // Codex restricted defaults permit this specific OS container-expectation
    // query during bootstrap; it does not grant filesystem or network access.
    '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
    // Resolve only ancestors of already declared roots/executable, without
    // granting directory contents or file data outside those roots.
    '(allow file-read-metadata file-test-existence (literal "/")',
    '  (path-ancestors (param "WORKSPACE_ROOT")) (path-ancestors (param "EXECUTABLE"))',
    ...sandbox.runtimeReadRoots.map((_, index) => `  (path-ancestors (param "RUNTIME_READ_${index}"))`),
    ")",
    '(allow file-read* (subpath (param "WORKSPACE_ROOT")) (literal (param "EXECUTABLE"))',
    '  (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share/locale")',
    '  (subpath "/usr/share/zoneinfo") (subpath "/private/var/db/dyld")',
    ...sandbox.runtimeReadRoots.map((_, index) => `  (subpath (param "RUNTIME_READ_${index}"))`),
    ")",
    // Codex restricted platform defaults separately permit executable mappings
    // for the loader. Keep them within the very same declared read authority.
    '(allow file-map-executable (subpath (param "WORKSPACE_ROOT")) (literal (param "EXECUTABLE"))',
    '  (subpath "/System/Library") (subpath "/usr/lib") (subpath "/usr/share/locale")',
    '  (subpath "/usr/share/zoneinfo") (subpath "/private/var/db/dyld")',
    ...sandbox.runtimeReadRoots.map((_, index) => `  (subpath (param "RUNTIME_READ_${index}"))`),
    ")",
    '(allow file-write* (subpath (param "WORKSPACE_ROOT")))',
    '(allow file-read* file-write-data (literal "/dev/null"))',
    '(allow sysctl-read (sysctl-name "hw.ncpu") (sysctl-name "hw.logicalcpu")',
    '  (sysctl-name "hw.activecpu") (sysctl-name "hw.physicalcpu") (sysctl-name "hw.memsize")',
    '  (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osproductversion")',
    '  (sysctl-name "kern.osversion") (sysctl-name "kern.argmax") (sysctl-name "kern.hostname") (sysctl-name "kern.version"))',
  ].join("\n");
  const parameters = ["-D", `WORKSPACE_ROOT=${sandbox.filesystemRoot}`, "-D", `EXECUTABLE=${executable}`];
  sandbox.runtimeReadRoots.forEach((path, index) => parameters.push("-D", `RUNTIME_READ_${index}=${path}`));
  return { profile, parameters };
}

/** The guardian accepts one complete profile rather than sandbox-exec -D flags. */
export function bindSingleProcessMacSandboxProfile(input: { profile: string; parameters: readonly string[] }): string {
  const bindings = new Map<string, string>();
  for (let index = 0; index < input.parameters.length; index += 2) {
    const entry = input.parameters[index + 1];
    if (input.parameters[index] !== "-D" || entry === undefined) throw new SingleProcessMacCapabilityError("Invalid sandbox parameter binding");
    const separator = entry.indexOf("=");
    const name = entry.slice(0, separator), value = entry.slice(separator + 1);
    if (separator < 1 || bindings.has(name) || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new SingleProcessMacCapabilityError("Unsupported sandbox parameter encoding");
    }
    bindings.set(name, `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
  }
  return input.profile.replace(/\(param "([A-Z0-9_]+)"\)/g, (_, name: string) => {
    const binding = bindings.get(name);
    if (binding === undefined) throw new SingleProcessMacCapabilityError("Unbound sandbox authority parameter");
    return binding;
  });
}
