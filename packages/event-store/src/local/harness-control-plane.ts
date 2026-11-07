import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  HarnessSetupRequestSchema, HarnessSetupResponseSchema,
  HarnessStatusRequestSchema, HarnessStatusResponseSchema,
  HarnessSelectionReadRequestSchema, HarnessSelectRequestSchema, HarnessSelectionResponseSchema,
  HarnessInstanceStatusSchema, LocalWorkspaceGrantSchema, LocalWorkspaceGrantPathSchema,
  PlatformEventSchema, UserIdSchema,
  type HarnessSetupRequest, type HarnessSetupResponse,
  type HarnessStatusRequest, type HarnessStatusResponse,
  type HarnessSelectionReadRequest, type HarnessSelectRequest, type HarnessSelectionResponse,
  type HarnessInstanceStatus, type Thread, type UserId,
} from "@repo/platform-protocol";
import { createStableEventFingerprint } from "../fingerprint.js";
import { LocalPersistenceError } from "../errors.js";

/** Private accountless LOCAL operations, not a credential or runtime authority. */
export interface LocalHarnessControlPlanePort {
  setup(input: HarnessSetupRequest): Promise<HarnessSetupResponse>;
  status(input: HarnessStatusRequest): Promise<HarnessStatusResponse>;
  readSelection(input: HarnessSelectionReadRequest): Promise<HarnessSelectionResponse>;
  select(input: HarnessSelectRequest): Promise<HarnessSelectionResponse>;
}

export class LocalHarnessControlPlaneError extends Error {
  readonly name = "LocalHarnessControlPlaneError";
  constructor(
    readonly code: "not_found" | "command_conflict" | "revision_conflict" | "instance_binding_conflict",
    message: string,
  ) { super(message); }
}

const InstanceRecordsSchema = z.object({
  version: z.literal(1),
  records: z.array(z.object({
    grantFingerprint: z.string().min(1),
    instance: HarnessInstanceStatusSchema,
  }).strict()).max(200),
}).strict();
const ReceiptSchema = z.object({
  version: z.literal(1), fingerprint: z.string().min(1), response: z.unknown(),
}).strict();
// Preserve physical-grant identity added by the existing writer owner. No copy
// of a grant or credential is persisted in this adapter's metadata records.
const GrantEnvelopeSchema = z.object({
  version: z.literal(1), path: LocalWorkspaceGrantPathSchema, grant: LocalWorkspaceGrantSchema,
}).passthrough();

/** Uses ONLY the process's existing exclusively owned SQLite writer. Every
 * operation is synchronous inside one immediate transaction; external health,
 * catalog, vault and provider I/O do not participate in the transaction.
 * The constructor actor MUST come from the canonical LocalThreadService owner.
 */
export class LocalHarnessControlPlane implements LocalHarnessControlPlanePort {
  private readonly actor: UserId;
  private readonly environmentId: string;
  constructor(private readonly database: Database.Database, options: { environmentId: string; userId: UserId }) {
    this.actor = UserIdSchema.parse(options.userId);
    this.environmentId = HarnessStatusRequestSchema.shape.environmentId.parse(options.environmentId);
  }

  async setup(value: HarnessSetupRequest): Promise<HarnessSetupResponse> {
    const input = HarnessSetupRequestSchema.parse(value);
    return this.withWriter(() => {
      const grantFingerprint = this.authorize(input);
      const fingerprint = digest({ input, grantFingerprint });
      const receiptKey = this.key(input, "setup", input.clientCommandId);
      const prior = this.receipt(receiptKey, fingerprint);
      if (prior !== null) {
        const response = this.setupResponse(input, prior);
        const record = this.instances(input).find((candidate) =>
          candidate.instance.instanceId === response.instance.instanceId);
        if (!record || record.grantFingerprint !== grantFingerprint ||
            digest(this.unavailable(record.instance)) !== digest(response.instance))
          throw new LocalPersistenceError("corrupt", "Local setup receipt has no matching configured instance");
        return response;
      }
      const recordsKey = this.key(input, "instances");
      const records = this.instances(input);
      const existing = input.instanceId === undefined ? undefined : records.find((record) =>
        record.instance.instanceId === input.instanceId);
      if (input.instanceId !== undefined && !existing)
        fail("not_found", "Reconnect instance was not found in this local scope");
      if (existing && (existing.grantFingerprint !== grantFingerprint ||
          existing.instance.harness !== input.harness || existing.instance.connectionId !== input.connectionId))
        fail("instance_binding_conflict", "Configured local instance binding is immutable");
      if (!existing && records.length >= 200)
        fail("instance_binding_conflict", "Configured local instance limit exceeded");
      const instance = existing?.instance ?? this.unavailable({
        workspaceId: input.workspaceId, environmentId: input.environmentId,
        harness: input.harness, connectionId: input.connectionId,
        instanceId: `harness_${randomUUID()}`, accountLabel: null, usage: null,
        state: "unavailable", reason: null,
        capabilities: unavailableCapabilities, runtimeVersion: null, protocolVersion: null,
        observedAt: new Date().toISOString(),
      });
      if (!existing) {
        records.push({ grantFingerprint, instance });
        this.write(recordsKey, { version: 1, records });
      }
      const response = HarnessSetupResponseSchema.parse({ instance: this.unavailable(instance) });
      this.saveReceipt(receiptKey, fingerprint, response);
      return response;
    });
  }

  async status(value: HarnessStatusRequest): Promise<HarnessStatusResponse> {
    const input = HarnessStatusRequestSchema.parse(value);
    return this.withWriter(() => {
      const grantFingerprint = this.authorize(input);
      return HarnessStatusResponseSchema.parse({ instances: this.instances(input)
        .filter((record) => record.grantFingerprint === grantFingerprint)
        .map((record) => this.unavailable(record.instance)) });
    });
  }

  async readSelection(value: HarnessSelectionReadRequest): Promise<HarnessSelectionResponse> {
    const input = HarnessSelectionReadRequestSchema.parse(value);
    return this.withWriter(() => {
      const grantFingerprint = this.authorizeThread(input);
      return this.selection(input, grantFingerprint);
    });
  }

  async select(value: HarnessSelectRequest): Promise<HarnessSelectionResponse> {
    const input = HarnessSelectRequestSchema.parse(value);
    return this.withWriter(() => {
      const grantFingerprint = this.authorizeThread(input);
      const fingerprint = digest({ input, grantFingerprint });
      const receiptKey = this.key(input, "select", input.sessionId, input.threadId, input.clientCommandId);
      const prior = this.receipt(receiptKey, fingerprint);
      if (prior !== null) return this.selectionResponse(input, prior);
      const current = this.selection(input, grantFingerprint);
      if (current.revision !== input.expectedRevision)
        fail("revision_conflict", "Local harness selection revision changed");
      if (input.selection !== null) {
        const selected = input.selection;
        const configured = this.instances(input).find((record) =>
          record.grantFingerprint === grantFingerprint && record.instance.instanceId === selected.instanceId);
        if (!configured || configured.instance.harness !== selected.harness ||
            configured.instance.connectionId !== selected.connectionId)
          fail("instance_binding_conflict", "Selected local instance is not configured for this grant");
      }
      if (!Number.isSafeInteger(current.revision + 1))
        fail("revision_conflict", "Local harness selection revision is exhausted");
      const response = HarnessSelectionResponseSchema.parse({
        environmentId: input.environmentId, workspaceId: input.workspaceId,
        sessionId: input.sessionId, threadId: input.threadId,
        revision: current.revision + 1, selection: input.selection,
      });
      this.write(this.selectionKey(input, grantFingerprint), response);
      this.saveReceipt(receiptKey, fingerprint, response);
      return response;
    });
  }

  private authorize(input: HarnessStatusRequest): string {
    const environment = this.read("local_environment_id_v1", false);
    if (environment !== input.environmentId || input.environmentId !== this.environmentId)
      fail("not_found", "Harness operation belongs to another local environment");
    const row = this.database.prepare("SELECT value_json FROM workspace_grant WHERE id=1")
      .get() as { value_json: string } | undefined;
    if (!row) fail("not_found", "Local harness workspace is not granted");
    const grant = GrantEnvelopeSchema.parse(JSON.parse(row.value_json));
    if (!isAbsolute(grant.path) || grant.path.includes("\0") ||
        grant.grant.workspaceId !== input.workspaceId || grant.grant.readiness !== "ready" ||
        !grant.grant.capabilities.includes("filesystem"))
      fail("not_found", "Local harness workspace grant is unavailable");
    // Full stored identity includes the physical fence when supplied by the
    // canonical grant writer. Regrant cannot revive an old receipt/selection.
    return digest(grant);
  }

  private authorizeThread(input: HarnessSelectionReadRequest): string {
    const grantFingerprint = this.authorize(input);
    if (input.sessionId !== input.threadId)
      fail("not_found", "Local conversation must use its canonical Thread identity");
    const rows = this.database.prepare(
      "SELECT event_json FROM events WHERE family='platform' AND stream_type='thread' AND stream_id=? ORDER BY sequence LIMIT 10001",
    ).all(input.threadId) as { event_json: string }[];
    if (rows.length > 10000) throw new LocalPersistenceError("corrupt", "Local Thread replay exceeds its bound");
    let thread: Thread | null = null;
    for (const [index, row] of rows.entries()) {
      const event = PlatformEventSchema.parse(JSON.parse(row.event_json));
      if (event.threadId !== input.threadId || event.workspaceId !== input.workspaceId ||
          event.scopeType !== "thread" || event.scopeId !== input.threadId || event.sequence !== index + 1 ||
          (index === 0 && event.type !== "thread.created") || (index > 0 && event.type === "thread.created"))
        throw new LocalPersistenceError("corrupt", "Local Thread stream identity is inconsistent");
      if (event.type === "thread.title.updated") continue;
      if (event.type !== "thread.created" && event.type !== "thread.pinned" && event.type !== "thread.unpinned" &&
          event.type !== "thread.archived" && event.type !== "thread.unarchived")
        throw new LocalPersistenceError("corrupt", "Local Thread stream contains an unexpected record");
      const record = event.payload.thread;
      if (record.id !== input.threadId || record.workspaceId !== input.workspaceId || record.userId !== this.actor)
        fail("not_found", "Local Thread does not belong to this actor and workspace");
      thread = record;
    }
    if (!thread || thread.status !== "active") fail("not_found", "Local Thread is missing or archived");
    return grantFingerprint;
  }

  private instances(input: HarnessStatusRequest): z.infer<typeof InstanceRecordsSchema>["records"] {
    const value = this.read(this.key(input, "instances"));
    if (value === null) return [];
    const records = InstanceRecordsSchema.parse(value).records;
    const ids = new Set<string>();
    for (const { instance } of records) {
      if (instance.environmentId !== input.environmentId || instance.workspaceId !== input.workspaceId || ids.has(instance.instanceId))
        throw new LocalPersistenceError("corrupt", "Configured local instance scope is inconsistent");
      ids.add(instance.instanceId);
    }
    return records;
  }
  private selection(input: HarnessSelectionReadRequest, grantFingerprint: string): HarnessSelectionResponse {
    const value = this.read(this.selectionKey(input, grantFingerprint));
    return value === null ? HarnessSelectionResponseSchema.parse({
      workspaceId: input.workspaceId, environmentId: input.environmentId,
      sessionId: input.sessionId, threadId: input.threadId, revision: 0, selection: null,
    })
      : this.selectionResponse(input, value);
  }
  private selectionResponse(input: HarnessSelectionReadRequest, value: unknown): HarnessSelectionResponse {
    const response = HarnessSelectionResponseSchema.parse(value);
    if (response.environmentId !== input.environmentId || response.workspaceId !== input.workspaceId ||
        response.sessionId !== input.sessionId || response.threadId !== input.threadId)
      throw new LocalPersistenceError("corrupt", "Stored local selection belongs to another conversation");
    return response;
  }
  private setupResponse(input: HarnessSetupRequest, value: unknown): HarnessSetupResponse {
    const response = HarnessSetupResponseSchema.parse(value);
    const instance = response.instance;
    if (instance.environmentId !== input.environmentId || instance.workspaceId !== input.workspaceId ||
        instance.harness !== input.harness || instance.connectionId !== input.connectionId ||
        (input.instanceId !== undefined && input.instanceId !== instance.instanceId))
      throw new LocalPersistenceError("corrupt", "Stored setup receipt belongs to another instance");
    return { instance: this.unavailable(instance) };
  }
  private unavailable(instance: HarnessInstanceStatus): HarnessInstanceStatus {
    return HarnessInstanceStatusSchema.parse({ ...instance, state: "unavailable",
      reason: "Local credential, installation and enforceable launch policy have not been verified",
      capabilities: unavailableCapabilities, accountLabel: null, usage: null, runtimeVersion: null, protocolVersion: null });
  }
  private selectionKey(input: HarnessSelectionReadRequest, grantFingerprint: string): string {
    return this.key(input, "selection", input.sessionId, input.threadId, grantFingerprint);
  }
  private key(input: HarnessStatusRequest, ...parts: string[]): string {
    return `local_harness_control_v1:${JSON.stringify([this.actor, input.environmentId, input.workspaceId, ...parts])}`;
  }
  private receipt(key: string, fingerprint: string): unknown | null {
    const value = this.read(key);
    if (value === null) return null;
    const saved = ReceiptSchema.parse(value);
    if (saved.fingerprint !== fingerprint) fail("command_conflict", "Local harness command identity was reused with changed content or grant");
    return saved.response;
  }
  private saveReceipt(key: string, fingerprint: string, response: unknown): void {
    this.write(key, { version: 1, fingerprint, response });
  }
  private read(key: string, json = true): unknown | null {
    const row = this.database.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined;
    return row ? (json ? JSON.parse(row.value) as unknown : row.value) : null;
  }
  private write(key: string, value: unknown): void {
    this.database.prepare("INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
  }
  private withWriter<T>(operation: () => T): T {
    try { return this.database.transaction(operation).immediate(); }
    catch (error) {
      if (error instanceof LocalHarnessControlPlaneError || error instanceof LocalPersistenceError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        throw new LocalPersistenceError("corrupt", "Stored local harness control metadata is invalid");
      throw new LocalPersistenceError("unavailable", "Local harness control operation failed safely");
    }
  }
}

const unavailableCapabilities = {
  approvals: false, questions: false, steer: false, resume: false, fork: false,
  images: false, terminal: false, contextTelemetry: false, accountQuota: false, experimental: false,
};
function fail(code: LocalHarnessControlPlaneError["code"], message: string): never {
  throw new LocalHarnessControlPlaneError(code, message);
}
function digest(value: unknown): string {
  return createHash("sha256").update(createStableEventFingerprint(value)).digest("hex");
}
