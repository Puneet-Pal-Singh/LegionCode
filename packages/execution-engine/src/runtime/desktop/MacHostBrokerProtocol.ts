import { createHash } from "node:crypto";
import { parseNativeGitMetadataIdentity, type NativeGitMetadataLayout } from "./NativeFilesystemBridge.js";
import { isAbsolute } from "node:path";
import type { LocalTurnAttemptIdentity } from "./LocalReadOnlyTurnExecutor.js";

/** Private native bridge framing. No renderer, provider credentials or public SDK. */
export const MAC_HOST_BROKER_ABI = "1";
export const MAC_HOST_MAX_FRAME = 128 * 1024;
const MAX_FIELDS = 32;
const keyPattern = /^[A-Za-z0-9]{1,63}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
export type MacHostFields = Readonly<Record<string, string | Buffer>>;

export class MacHostBrokerError extends Error {
  readonly code = "native_host_execution_unavailable";
  constructor(readonly reason: string, readonly outcomeUnknown: boolean) {
    super("Native host execution is unavailable: " + reason);
    this.name = "MacHostBrokerError";
  }
}

export function encodeMacHostFrame(values: MacHostFields): Buffer {
  const entries = Object.entries(values);
  if (!entries.length || entries.length > MAX_FIELDS) throw new MacHostBrokerError("invalid_request", false);
  let length = 2;
  const fields = entries.map(([key, value]) => {
    if (!keyPattern.test(key) || key === "rootFd" || key === "fenceFd" || key === "namespaceFd") throw new MacHostBrokerError("invalid_request", false);
    const name = Buffer.from(key), bytes = typeof value === "string" ? Buffer.from(value) : value;
    if (bytes.length > MAC_HOST_MAX_FRAME) throw new MacHostBrokerError("request_too_large", false);
    length += 5 + name.length + bytes.length;
    return { name, bytes };
  });
  if (length > MAC_HOST_MAX_FRAME) throw new MacHostBrokerError("request_too_large", false);
  const result = Buffer.alloc(length + 4);
  result.writeUInt32BE(length, 0); result.writeUInt16BE(fields.length, 4);
  let at = 6;
  for (const { name, bytes } of fields) {
    result[at++] = name.length; name.copy(result, at); at += name.length;
    result.writeUInt32BE(bytes.length, at); at += 4; bytes.copy(result, at); at += bytes.length;
  }
  return result;
}

export function decodeMacHostFrame(body: Buffer): ReadonlyMap<string, Buffer> {
  if (body.length < 2 || body.length > MAC_HOST_MAX_FRAME) throw new MacHostBrokerError("invalid_response", true);
  const count = body.readUInt16BE(0);
  if (!count || count > MAX_FIELDS) throw new MacHostBrokerError("invalid_response", true);
  const result = new Map<string, Buffer>(); let at = 2;
  for (let i = 0; i < count; i++) {
    const size = body[at++];
    if (!size || at + size + 4 > body.length) throw new MacHostBrokerError("invalid_response", true);
    const key = body.subarray(at, at + size).toString("ascii"); at += size;
    if (!keyPattern.test(key) || result.has(key)) throw new MacHostBrokerError("invalid_response", true);
    const length = body.readUInt32BE(at); at += 4;
    if (length > MAC_HOST_MAX_FRAME || at + length > body.length) throw new MacHostBrokerError("invalid_response", true);
    result.set(key, Buffer.from(body.subarray(at, at + length))); at += length;
  }
  if (at !== body.length) throw new MacHostBrokerError("invalid_response", true);
  return result;
}

export function macHostText(fields: ReadonlyMap<string, Buffer>, key: string, maximum = 4096): string {
  const bytes = fields.get(key);
  if (!bytes || bytes.length > maximum || bytes.includes(0)) throw new MacHostBrokerError("invalid_response", true);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new MacHostBrokerError("invalid_response", true); }
}
export function macHostDigest(fields: ReadonlyMap<string, Buffer>, key: string): string {
  const value = macHostText(fields, key, 64);
  if (!digestPattern.test(value)) throw new MacHostBrokerError("invalid_response", true);
  return value;
}
export function macHostNumber(fields: ReadonlyMap<string, Buffer>, key: string): bigint {
  const value = macHostText(fields, key, 32);
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(value)) throw new MacHostBrokerError("invalid_response", true);
  return BigInt(value);
}
export function macHostScopeDigest(attempt: LocalTurnAttemptIdentity): string {
  const hash = createHash("sha256");
  for (const key of ["workspaceId", "threadId", "runId", "turnId", "runAttemptId"] as const) hash.update(attempt[key]).update("\0");
  return hash.digest("hex");
}
export function macHostCommandDigest(command: string, cwd: string): string {
  return createHash("sha256").update(command).update("\0").update(cwd).update("\0").digest("hex");
}

/** Frozen canonical inspector receipt; never constructed from tool/renderer fields. */
export function macHostMetadataFields(layout: NativeGitMetadataLayout): Readonly<Record<string, string>> {
  const storage = layout.storage;
  if (!storage || storage.alternates !== "absent_or_empty" || storage.grafts !== "absent_or_empty" ||
      !/^gitstorage-v1(?::[0-9a-f]{1,16}){20}$/u.test(storage.identity)) throw new MacHostBrokerError("metadata_storage_unavailable", false);
  const fields = {
    metadataIdentity: parseNativeGitMetadataIdentity(layout.identity), storageIdentity: storage.identity,
    gitDirectory: layout.gitDirectory, commonDirectory: layout.commonDirectory, backlinkPath: layout.backlinkPath ?? "",
    objectsDirectory: storage.objectsDirectory, packDirectory: storage.packDirectory, infoDirectory: storage.infoDirectory,
    refsDirectory: storage.refsDirectory, commonLogsDirectory: storage.commonLogsDirectory,
    worktreeLogsDirectory: storage.worktreeLogsDirectory, repositoryInfoDirectory: storage.repositoryInfoDirectory,
  };
  if ((layout.kind === "linked") !== layout.identity.startsWith("gitdir-v2:") ||
      (layout.kind === "ordinary" && (layout.gitDirectory !== layout.commonDirectory || layout.backlinkPath !== null)) ||
      Object.entries(fields).some(([key, value]) => key !== "metadataIdentity" && key !== "storageIdentity" &&
        !(key === "backlinkPath" && value === "") && (!isAbsolute(value) || Buffer.byteLength(value) > 500 || /[\0\r\n]/u.test(value)))) {
    throw new MacHostBrokerError("invalid_metadata_layout", false);
  }
  return Object.freeze(fields);
}
export function macHostMetadataDigest(fields: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const [key, value] of Object.entries(fields)) hash.update(key).update("\0").update(value).update("\0");
  return hash.digest("hex");
}
