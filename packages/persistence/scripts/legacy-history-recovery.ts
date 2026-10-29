import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { deserialize } from "node:v8";

import {
  PostgresTranscriptRepository,
  withPostgresSqlClient,
  type LegacyHistoryImportMessage,
  type PgSqlClient,
} from "../src/index.js";
import type { JsonValue } from "@repo/shared-types";

const APPROVED_GITHUB_SUBJECT = "46601256";
const APPROVED_LOCAL_NAMESPACE = "shadowbox-api-AgentRuntime";
const MIGRATION_ID = "0034_legacy_history_import_receipts";

interface FrozenInventory {
  version: 1;
  sourceEnvironment: string;
  sourceNamespace: string;
  inventoryCutoff: string;
  githubSubject: string;
  records: Array<{
    sourceKind: "local_wrangler_sqlite";
    sourceDoId: null;
    sourceInstance: string;
    sourceStorageKey: string;
    sourceSha256: string;
    sourceSizeBytes: number;
    sourceCreatedAt: string | null;
    sourceRawBase64: string;
    messages: Array<{
      role: LegacyHistoryImportMessage["role"];
      sourceMessageId: string | null;
      createdAt: string | null;
      parts: LegacyHistoryImportMessage["parts"];
    }>;
  }>;
  inventorySha256: string;
}

interface SourceRow {
  key: string;
  raw: string;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL?.trim();
  if (args.apply) {
    if (!args.inventoryPath) throw new Error("--inventory is required with --apply");
    if (!args.sourceDir) throw new Error("--source-dir is required with --apply to verify the frozen source has not changed");
    if (!connectionString) {
      throw new Error("DATABASE_URL must identify the target Postgres environment; its value is never printed");
    }
    const inventory = readFrozenInventory(args.inventoryPath);
    verifyCurrentSource(inventory, args.sourceDir);
    await withPostgresSqlClient(connectionString, async (client) => {
      const userId = await resolveApprovedUser(client);
      await requireImportMigration(client);
      const repository = new PostgresTranscriptRepository(client);
      const result = await repository.importLegacyHistoryInventory({
        sourceEnvironment: inventory.sourceEnvironment,
        sourceNamespace: inventory.sourceNamespace,
        inventorySha256: inventory.inventorySha256,
        inventoryCutoff: new Date(inventory.inventoryCutoff),
        githubSubject: inventory.githubSubject,
        userId,
        sessionTitle: "Recovered legacy conversation",
        records: inventory.records.map((record) => ({
          sourceKind: record.sourceKind,
          sourceDoId: record.sourceDoId,
          sourceInstance: record.sourceInstance,
          sourceStorageKey: record.sourceStorageKey,
          sourceSha256: record.sourceSha256,
          sourceCreatedAt: record.sourceCreatedAt ? new Date(record.sourceCreatedAt) : null,
          sourceRaw: Buffer.from(record.sourceRawBase64, "base64"),
          messages: record.messages.map((message) => ({
            role: message.role,
            sourceMessageId: message.sourceMessageId,
            createdAt: message.createdAt ? new Date(message.createdAt) : null,
            parts: message.parts,
          })),
        })),
      });
      process.stdout.write(`${JSON.stringify({ mode: "applied", ...result })}\n`);
    });
    return;
  }

  if (!args.sourceDir || !args.sourceEnvironment) {
    throw new Error("Dry-run requires --source-dir and --source-environment");
  }
  if (!args.sourceEnvironment.trim()) throw new Error("--source-environment must not be empty");
  const inventory = scanLocalWranglerInventory(args.sourceDir, args.sourceEnvironment);
  const summary = summarizeInventory(inventory);
  if (connectionString) {
    await withPostgresSqlClient(connectionString, async (client) => {
      await resolveApprovedUser(client);
      process.stdout.write(`${JSON.stringify({ ...summary, targetAccountVerified: true })}\n`);
    });
  } else {
    process.stdout.write(`${JSON.stringify({ ...summary, targetAccountVerified: false })}\n`);
  }
  if (args.freezePath) {
      writeFileSync(args.freezePath, `${JSON.stringify(inventory, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      process.stdout.write(`Frozen inventory written to ${resolve(args.freezePath)}\n`);
  }
}

function scanLocalWranglerInventory(
  sourceDirectory: string,
  sourceEnvironment: string,
): FrozenInventory {
  const directory = resolve(sourceDirectory);
  const namespace = basename(directory);
  if (namespace !== APPROVED_LOCAL_NAMESPACE) {
    throw new Error(`Expected the fixed local namespace directory ${APPROVED_LOCAL_NAMESPACE}`);
  }
  const cutoff = new Date();
  const records: FrozenInventory["records"] = [];
  const totals = { referencedR2: 0, unsupportedRecords: 0 };
  const databaseFiles = readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.sqlite$/.test(name))
    .sort();
  if (databaseFiles.length === 0) throw new Error("No fixed Wrangler SQLite source files were found");

  const capturedRows = readLocalHistoryRows(directory);
  for (const sourceInstance of databaseFiles) {
    const rows = capturedRows.get(sourceInstance) ?? [];
    for (const row of rows) {
      const sourceRaw = Buffer.from(row.raw, "hex");
      if (sourceRaw.length === 0) throw new Error(`Empty source value at ${sourceInstance}/${row.key}`);
      let value: unknown;
      try {
        value = deserialize(sourceRaw);
      } catch {
        totals.unsupportedRecords += 1;
        throw new Error(`Unsupported Durable Object value encoding at ${sourceInstance}/${row.key}`);
      }
      totals.referencedR2 += countR2References(value);
      const projection = projectMessages(value, row.key);
      if (projection.messages.length === 0) {
        totals.unsupportedRecords += 1;
        throw new Error(`No recognized message envelope at ${sourceInstance}/${row.key}`);
      }
      const rawSha256 = sha256(sourceRaw);
      records.push({
        sourceKind: "local_wrangler_sqlite",
        sourceDoId: null,
        sourceInstance,
        sourceStorageKey: row.key,
        sourceSha256: rawSha256,
        sourceSizeBytes: sourceRaw.byteLength,
        sourceCreatedAt: iso(projection.sourceCreatedAt),
        sourceRawBase64: sourceRaw.toString("base64"),
        messages: projection.messages.map((message) => ({
          role: message.role,
          sourceMessageId: message.sourceMessageId,
          createdAt: iso(message.createdAt),
          parts: message.parts,
        })),
      });
    }
  }
  if (records.length === 0) throw new Error("The fixed local inventory contains no history: or chat: values");
  if (totals.referencedR2 > 0) {
    throw new Error(`Inventory has ${totals.referencedR2} R2 references; capture the exact object bytes before importing`);
  }
  if (totals.unsupportedRecords > 0) {
    throw new Error("Inventory contains unsupported records; preserve and classify them before importing");
  }
  records.sort((left, right) =>
    left.sourceInstance.localeCompare(right.sourceInstance) ||
    left.sourceStorageKey.localeCompare(right.sourceStorageKey),
  );
  const body = {
    version: 1 as const,
    sourceEnvironment,
    sourceNamespace: namespace,
    inventoryCutoff: cutoff.toISOString(),
    githubSubject: APPROVED_GITHUB_SUBJECT,
    records,
  };
  return { ...body, inventorySha256: sha256(canonicalStringify(body)) };
}

function readLocalHistoryRows(directory: string): Map<string, SourceRow[]> {
  const python = [
    "import json, os, re, sqlite3, sys",
    "from urllib.parse import quote",
    "directory = sys.argv[1]",
    "captured = {}",
    "for name in sorted(os.listdir(directory)):",
    " if not re.fullmatch(r'[a-f0-9]{64}\\.sqlite', name): continue",
    " path = os.path.join(directory, name)",
    " sidecars = [path, path + '-wal']",
    " def stamp(): return tuple((os.stat(item).st_size, os.stat(item).st_mtime_ns) if os.path.exists(item) else None for item in sidecars)",
    " before = stamp()",
    " connection = sqlite3.connect('file:' + quote(path, safe='/') + '?mode=ro', uri=True, timeout=0)",
    " try:",
    "  tables = {row[0] for row in connection.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")}",
    `  rows = [] if '_cf_KV' not in tables else [dict(key=row[0], raw=row[1]) for row in connection.execute("SELECT key, hex(value) FROM _cf_KV WHERE key LIKE 'history:%' OR key LIKE 'chat:%' ORDER BY key")]`,
    " finally:",
    "  connection.close()",
    " after = stamp()",
    " if before != after: raise RuntimeError('source changed during read: ' + name)",
    " if rows: captured[name] = rows",
    "print(json.dumps(captured, separators=(',', ':'))) ",
  ].join("\n");
  const result = spawnSync("python3", ["-c", python, directory], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Read-only SQLite inventory scan failed: ${result.stderr.trim()}`);
  }
  const output = result.stdout.trim();
  const captured: unknown = JSON.parse(output);
  if (!isRecord(captured)) {
    throw new Error("Unexpected read-only SQLite inventory result");
  }
  const inventory = new Map<string, SourceRow[]>();
  for (const [sourceInstance, value] of Object.entries(captured)) {
    if (!Array.isArray(value)) throw new Error(`Invalid SQLite rows for ${sourceInstance}`);
    const rows: SourceRow[] = [];
    for (const row of value) {
      if (!isRecord(row) || typeof row.key !== "string" || typeof row.raw !== "string") {
        throw new Error(`Invalid SQLite history row in ${sourceInstance}`);
      }
      rows.push({ key: row.key, raw: row.raw });
    }
    inventory.set(sourceInstance, rows);
  }
  return inventory;
}

function verifyCurrentSource(inventory: FrozenInventory, sourceDirectory: string): void {
  if (basename(resolve(sourceDirectory)) !== inventory.sourceNamespace) {
    throw new Error("--source-dir must identify the original frozen local namespace");
  }
  const current = readLocalHistoryRows(resolve(sourceDirectory));
  const expected = new Map<string, string>();
  for (const record of inventory.records) {
    expected.set(`${record.sourceInstance}\u0000${record.sourceStorageKey}`, record.sourceSha256);
  }
  const observed = new Map<string, string>();
  for (const [sourceInstance, rows] of current) {
    for (const row of rows) {
      observed.set(`${sourceInstance}\u0000${row.key}`, sha256(Buffer.from(row.raw, "hex")));
    }
  }
  if (expected.size !== observed.size) {
    throw new Error("Frozen inventory no longer matches the current source row count; recapture and review it");
  }
  for (const [identity, digest] of expected) {
    if (observed.get(identity) !== digest) {
      throw new Error("Frozen inventory no longer matches current source bytes; recapture and review it");
    }
  }
}

function projectMessages(
  value: unknown,
  sourceStorageKey: string,
): {
  messages: LegacyHistoryImportMessage[];
  sourceCreatedAt: Date | null;
} {
  const values = Array.isArray(value) ? value : [value];
  const timestamp = readKeyTimestamp(sourceStorageKey);
  const messages: LegacyHistoryImportMessage[] = [];
  for (const entry of values) {
    if (!isRecord(entry) || !isRole(entry.role)) continue;
    const parts: LegacyHistoryImportMessage["parts"] = [];
    const sourceMessageId = typeof entry.id === "string" ? entry.id : null;
    if (entry.role === "tool") {
      const toolCallId = typeof entry.tool_call_id === "string" ? entry.tool_call_id : null;
      parts.push({
        type: "tool_result",
        content: { tool_call_id: entry.tool_call_id ?? null, content: toJsonValue(entry.content) },
        sourcePartId: null,
        sourceToolCallId: toolCallId,
      });
    } else if (typeof entry.content === "string") {
      parts.push({
        type: "text",
        content: entry.content,
        sourcePartId: null,
        sourceToolCallId: null,
      });
    } else if (Array.isArray(entry.content)) {
      for (const contentPart of entry.content) {
        if (isRecord(contentPart)) {
          const sourcePartId = typeof contentPart.id === "string" ? contentPart.id : null;
          const sourceToolCallId =
            typeof contentPart.toolCallId === "string"
              ? contentPart.toolCallId
              : typeof contentPart.id === "string" &&
                  (contentPart.type === "tool-call" || contentPart.type === "tool_result")
                ? contentPart.id
                : null;
          if (contentPart.type === "text") {
            parts.push({
              type: "text",
              content: toJsonValue(contentPart),
              sourcePartId,
              sourceToolCallId: null,
            });
          } else if (contentPart.type === "tool-call" || contentPart.type === "tool_use") {
            parts.push({
              type: "tool_call",
              content: toJsonValue(contentPart),
              sourcePartId,
              sourceToolCallId,
            });
          } else if (contentPart.type === "tool-result" || contentPart.type === "tool_result") {
            parts.push({
              type: "tool_result",
              content: toJsonValue(contentPart),
              sourcePartId,
              sourceToolCallId,
            });
          } else {
            parts.push({
              type: "raw",
              content: toJsonValue(contentPart),
              sourcePartId,
              sourceToolCallId: null,
            });
          }
        } else {
          parts.push({
            type: "raw",
            content: toJsonValue(contentPart),
            sourcePartId: null,
            sourceToolCallId: null,
          });
        }
      }
    } else {
      parts.push({
        type: "raw",
        content: { sourceField: "content", value: toJsonValue(entry.content) },
        sourcePartId: null,
        sourceToolCallId: null,
      });
    }
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        const toolCallId = isRecord(call) && typeof call.id === "string" ? call.id : null;
        parts.push({
          type: "tool_call",
          content: toJsonValue(call),
          sourcePartId: null,
          sourceToolCallId: toolCallId,
        });
      }
    } else if (entry.tool_calls !== undefined && entry.tool_calls !== null) {
      parts.push({
        type: "raw",
        content: { sourceField: "tool_calls", value: toJsonValue(entry.tool_calls) },
        sourcePartId: null,
        sourceToolCallId: null,
      });
    }
    const unknownFields = Object.fromEntries(
      Object.entries(entry).filter(([key]) =>
        !["id", "role", "content", "tool_calls", "tool_call_id"].includes(key),
      ),
    );
    if (Object.keys(unknownFields).length > 0) {
      parts.push({
        type: "raw",
        content: { sourceFields: toJsonValue(unknownFields) },
        sourcePartId: null,
        sourceToolCallId: null,
      });
    }
    if (parts.length === 0) {
      parts.push({
        type: "raw",
        content: toJsonValue(entry),
        sourcePartId: null,
        sourceToolCallId: null,
      });
    }
    messages.push({ role: entry.role, sourceMessageId, createdAt: timestamp, parts });
  }
  return { messages, sourceCreatedAt: timestamp };
}

function countR2References(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + countR2References(item), 0);
  if (!isRecord(value)) return 0;
  const own = value.type === "r2_ref" && typeof value.key === "string" ? 1 : 0;
  return own + Object.values(value).reduce((count, item) => count + countR2References(item), 0);
}

function readKeyTimestamp(key: string): Date | null {
  if (!key.startsWith("chat:")) return null;
  const match = /^chat:[^:]+:(\d{15})(?:-[a-z0-9]+)?$/.exec(key);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? new Date(value) : null;
}

function readFrozenInventory(path: string): FrozenInventory {
  const inventory = JSON.parse(readFileSync(path, "utf8")) as FrozenInventory;
  if (
    inventory.version !== 1 ||
    inventory.sourceNamespace !== APPROVED_LOCAL_NAMESPACE ||
    inventory.githubSubject !== APPROVED_GITHUB_SUBJECT ||
    !Array.isArray(inventory.records) ||
    !Number.isFinite(new Date(inventory.inventoryCutoff).getTime())
  ) {
    throw new Error("Frozen inventory does not match the approved local source and account scope");
  }
  const { inventorySha256, ...body } = inventory;
  if (!/^[0-9a-f]{64}$/.test(inventorySha256) || sha256(canonicalStringify(body)) !== inventorySha256) {
    throw new Error("Frozen inventory digest does not match its contents");
  }
  for (const record of inventory.records) {
    if (
      record.sourceKind !== "local_wrangler_sqlite" ||
      record.sourceDoId !== null ||
      !/^[a-f0-9]{64}\.sqlite$/.test(record.sourceInstance) ||
      typeof record.sourceStorageKey !== "string" ||
      !Number.isSafeInteger(record.sourceSizeBytes) ||
      record.sourceSizeBytes < 0 ||
      !/^(history|chat):/.test(record.sourceStorageKey)
    ) {
      throw new Error("Frozen inventory contains a source identity outside the approved local capture");
    }
    const bytes = Buffer.from(record.sourceRawBase64, "base64");
    if (bytes.toString("base64") !== record.sourceRawBase64 ||
        bytes.byteLength !== record.sourceSizeBytes ||
        sha256(bytes) !== record.sourceSha256) {
      throw new Error(`Frozen source bytes or digest are invalid: ${record.sourceStorageKey}`);
    }
  }
  return inventory;
}

async function resolveApprovedUser(client: PgSqlClient): Promise<string> {
  const result = await client.query<{ user_id?: string }>(
    `SELECT accounts.user_id::text AS user_id
      FROM accounts JOIN users ON users.id = accounts.user_id
      WHERE accounts.provider = 'github' AND accounts.provider_account_id = $1
      LIMIT 2`,
    [APPROVED_GITHUB_SUBJECT],
  );
  if (result.rows.length !== 1 || typeof result.rows[0]?.user_id !== "string") {
    throw new Error("GitHub subject 46601256 must resolve to exactly one target account");
  }
  return result.rows[0].user_id;
}

async function requireImportMigration(client: PgSqlClient): Promise<void> {
  const result = await client.query(
    "SELECT 1 FROM schema_migrations WHERE id = $1",
    [MIGRATION_ID],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Required persistence migration ${MIGRATION_ID} is not applied; this command never applies migrations`);
  }
}

function summarizeInventory(inventory: FrozenInventory): Record<string, unknown> {
  const roleCounts: Record<string, number> = {};
  let messages = 0;
  let messagesWithSourceTimestamp = 0;
  let parts = 0;
  let rawBytes = 0;
  let toolCalls = 0;
  let rawParts = 0;
  let codeArtifactCalls = 0;
  let codeArtifactInlineContent = 0;
  let codeArtifactR2References = 0;
  for (const record of inventory.records) {
    rawBytes += Buffer.from(record.sourceRawBase64, "base64").byteLength;
    messages += record.messages.length;
    for (const message of record.messages) {
      roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1;
      if (message.createdAt !== null) messagesWithSourceTimestamp += 1;
      parts += message.parts.length;
      toolCalls += message.parts.filter((part) => part.type === "tool_call").length;
      rawParts += message.parts.filter((part) => part.type === "raw").length;
      for (const part of message.parts) {
        if (part.type !== "tool_call") continue;
        const preview = summarizeCodeArtifactCall(part.content);
        codeArtifactCalls += preview.called ? 1 : 0;
        codeArtifactInlineContent += preview.inline ? 1 : 0;
        codeArtifactR2References += preview.r2Reference ? 1 : 0;
      }
    }
  }
  return {
    mode: "dry-run",
    sourceEnvironment: inventory.sourceEnvironment,
    sourceNamespace: inventory.sourceNamespace,
    sourceKind: "local_wrangler_sqlite",
    logicalDoId: "unknown",
    githubSubject: inventory.githubSubject,
    records: inventory.records.length,
    messages,
    messagesWithSourceTimestamp,
    parts,
    toolCalls,
    rawParts,
    codeArtifactCalls,
    codeArtifactInlineContent,
    codeArtifactR2References,
    rawBytes,
    roleCounts,
    inventoryCutoff: inventory.inventoryCutoff,
    inventorySha256: inventory.inventorySha256,
    targetAccountVerified: false,
    targetAccountResolutionRequiredBeforeApply: true,
    importApplied: false,
  };
}

function summarizeCodeArtifactCall(value: JsonValue): {
  called: boolean;
  inline: boolean;
  r2Reference: boolean;
} {
  if (!isRecord(value)) return { called: false, inline: false, r2Reference: false };
  const functionRecord = isRecord(value.function) ? value.function : null;
  const name = typeof value.toolName === "string"
    ? value.toolName
    : functionRecord && typeof functionRecord.name === "string"
      ? functionRecord.name
      : null;
  if (name !== "create_code_artifact") {
    return { called: false, inline: false, r2Reference: false };
  }
  let args: unknown = value.args;
  if (functionRecord && typeof functionRecord.arguments === "string") {
    try { args = JSON.parse(functionRecord.arguments) as unknown; } catch { args = null; }
  }
  const content = isRecord(args) ? args.content : null;
  return {
    called: true,
    inline: typeof content === "string",
    r2Reference: isRecord(content) && content.type === "r2_ref" && typeof content.key === "string",
  };
}

function parseArguments(values: string[]): {
  apply: boolean;
  sourceDir?: string;
  sourceEnvironment?: string;
  inventoryPath?: string;
  freezePath?: string;
} {
  const result: {
    apply: boolean;
    sourceDir?: string;
    sourceEnvironment?: string;
    inventoryPath?: string;
    freezePath?: string;
  } = { apply: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") continue;
    if (value === "--apply") result.apply = true;
    else if (value === "--source-dir") result.sourceDir = readOptionValue(values, ++index, value);
    else if (value === "--source-environment") result.sourceEnvironment = readOptionValue(values, ++index, value);
    else if (value === "--inventory") result.inventoryPath = readOptionValue(values, ++index, value);
    else if (value === "--freeze-to") result.freezePath = readOptionValue(values, ++index, value);
    else throw new Error(`Unknown option: ${value}`);
  }
  return result;
}

function readOptionValue(values: string[], index: number, option: string): string {
  const value = values[index]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function isRole(value: unknown): value is LegacyHistoryImportMessage["role"] {
  return value === "user" || value === "assistant" || value === "system" || value === "tool";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]));
  }
  throw new Error("Legacy message contains a non-JSON value that needs explicit preservation review");
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown recovery command failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
