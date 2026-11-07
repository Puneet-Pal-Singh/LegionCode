import { randomUUID } from "node:crypto";
import {
  HarnessSetupRequestSchema,
  HarnessSelectRequestSchema,
  HarnessSelectionReadRequestSchema,
  HarnessSelectionResponseSchema,
  HarnessNextSelectionSchema,
  HarnessAdmissionSelectionSchema,
  type HarnessAdmissionSelection,
  type HarnessSetupRequest,
  type HarnessSelectRequest,
  type HarnessSelectionReadRequest,
  type HarnessSelectionResponse,
  type HarnessSelection,
  type HarnessKind,
} from "@repo/platform-protocol";
import { createStableEventFingerprint } from "@repo/event-store";
import type { SqlClient, SqlRow } from "../sql.js";
export interface HarnessControlPlaneScope {
  userId: string;
  workspaceId: string;
  environmentId: string;
}
export interface StoredHarnessInstance extends HarnessControlPlaneScope {
  instanceId: string;
  harness: HarnessKind;
  connectionId: string;
  authOwnerGeneration: number;
  createdAt: string;
}
export interface FreezeHarnessAdmissionInput {
  scope: HarnessControlPlaneScope;
  sessionId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  selectionRevision: number;
  requestFingerprint: string;
  binding: HarnessSelection;
}
export class HarnessControlPlaneConflictError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "command_conflict"
      | "revision_conflict"
      | "instance_binding_conflict"
      | "connection_unavailable"
      | "admission_conflict",
    message: string,
  ) {
    super(message);
    this.name = "HarnessControlPlaneConflictError";
  }
}
interface InstanceRow extends SqlRow {
  user_id: string;
  workspace_id: string;
  environment_id: string;
  instance_id: string;
  harness: string;
  connection_id: string;
  auth_owner_generation: string | number;
  created_at: string | Date;
}
interface SelectionRow extends SqlRow {
  revision: string | number;
  selection_json: unknown;
}
/** Configured ownership and future selections only. Host health/models remain P09 facts. */
export class PostgresHarnessControlPlaneRepository {
  constructor(private readonly client: SqlClient) {}
  async setupInstance(
    scope: HarnessControlPlaneScope,
    input: HarnessSetupRequest,
    connection: { connectionId: string; ownerGeneration: number },
  ): Promise<StoredHarnessInstance> {
    const params = HarnessSetupRequestSchema.parse(input);
    assertScope(scope, params);
    if (params.connectionId !== connection.connectionId)
      fail("connection_unavailable", "Selected connection does not match");
    safeRevision(connection.ownerGeneration);
    const fp = createStableEventFingerprint({
      params,
      ownerGeneration: connection.ownerGeneration,
    });
    return this.client.transaction(async (tx) => {
      await ownedWorkspace(tx, scope);
      await lock(tx, ["harness-setup-command", scope, params.clientCommandId]);
      const prior = await receipt(
        tx,
        scope,
        "setup",
        "",
        params.clientCommandId,
        fp,
      );
      if (prior) return instanceFromJson(prior);
      const instanceId = params.instanceId ?? "harness_" + randomUUID();
      await lock(tx, ["harness-instance", scope, instanceId]);
      await activeConnection(
        tx,
        scope,
        connection.connectionId,
        connection.ownerGeneration,
      );
      let record = await readInstance(tx, scope, instanceId, true);
      if (
        record &&
        (record.harness !== params.harness ||
          record.connectionId !== params.connectionId ||
          record.authOwnerGeneration !== connection.ownerGeneration)
      )
        fail(
          "instance_binding_conflict",
          "Configured instance is immutable; use a new instance identity",
        );
      if (!record && params.instanceId)
        fail("not_found", "Reconnect instance was not found");
      if (!record) {
        const rows = await tx.query<InstanceRow>(
          `INSERT INTO harness_configured_instances(user_id,workspace_id,environment_id,instance_id,harness,connection_id,auth_owner_generation)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            scope.userId,
            scope.workspaceId,
            scope.environmentId,
            instanceId,
            params.harness,
            params.connectionId,
            connection.ownerGeneration,
          ],
        );
        if (!rows.rows[0])
          fail(
            "instance_binding_conflict",
            "Configured instance was not returned",
          );
        record = mapInstance(rows.rows[0]);
      }
      await saveReceipt(
        tx,
        scope,
        "setup",
        "",
        params.clientCommandId,
        fp,
        record,
      );
      return record;
    });
  }
  async listInstances(
    scope: HarnessControlPlaneScope,
  ): Promise<StoredHarnessInstance[]> {
    return this.client.transaction(async (tx) => {
      await ownedWorkspace(tx, scope);
      const result = await tx.query<InstanceRow>(
        "SELECT * FROM harness_configured_instances WHERE user_id::text=$1 AND workspace_id=$2 AND environment_id=$3 ORDER BY created_at,instance_id LIMIT 201",
        [scope.userId, scope.workspaceId, scope.environmentId],
      );
      if (result.rows.length > 200)
        fail("instance_binding_conflict", "Configured instance limit exceeded");
      return result.rows.map(mapInstance);
    });
  }
  async readInstance(
    scope: HarnessControlPlaneScope,
    instanceId: string,
  ): Promise<StoredHarnessInstance | null> {
    return this.client.transaction(async (tx) => {
      await ownedWorkspace(tx, scope);
      return readInstance(tx, scope, instanceId, false);
    });
  }
  async readSelection(
    scope: HarnessControlPlaneScope,
    input: HarnessSelectionReadRequest,
  ): Promise<HarnessSelectionResponse> {
    const params = HarnessSelectionReadRequestSchema.parse(input);
    assertScope(scope, params);
    return this.client.transaction(async (tx) => {
      await ownedConversation(tx, scope, params, false);
      return selectionResponse(
        params,
        await selectionRow(tx, scope, params, false),
      );
    });
  }
  async readSelectionReceipt(
    scope: HarnessControlPlaneScope,
    input: HarnessSelectRequest,
  ): Promise<HarnessSelectionResponse | null> {
    const params = HarnessSelectRequestSchema.parse(input);
    assertScope(scope, params);
    return this.client.transaction(async (tx) => {
      await ownedConversation(tx, scope, params, false);
      const saved = await receipt(
        tx,
        scope,
        "select",
        conversationKey(params),
        params.clientCommandId,
        createStableEventFingerprint(params),
      );
      return saved === null
        ? null
        : HarnessSelectionResponseSchema.parse(saved);
    });
  }
  async select(
    scope: HarnessControlPlaneScope,
    input: HarnessSelectRequest,
  ): Promise<HarnessSelectionResponse> {
    const params = HarnessSelectRequestSchema.parse(input);
    assertScope(scope, params);
    const fp = createStableEventFingerprint(params);
    return this.client.transaction(async (tx) => {
      await ownedConversation(tx, scope, params, true);
      const saved = await receipt(
        tx,
        scope,
        "select",
        conversationKey(params),
        params.clientCommandId,
        fp,
      );
      if (saved !== null) return HarnessSelectionResponseSchema.parse(saved);
      const current = await selectionRow(tx, scope, params, true);
      if (number(current?.revision ?? 0) !== params.expectedRevision)
        fail("revision_conflict", "Harness selection revision changed");
      if (params.selection) {
        const configured = await readInstance(
          tx,
          scope,
          params.selection.instanceId,
          true,
        );
        if (
          !configured ||
          configured.harness !== params.selection.harness ||
          configured.connectionId !== params.selection.connectionId
        )
          fail(
            "instance_binding_conflict",
            "Selected configured instance does not match",
          );
        await activeConnection(
          tx,
          scope,
          configured.connectionId,
          configured.authOwnerGeneration,
        );
      }
      const next = params.expectedRevision + 1;
      safeRevision(next);
      await tx.query(
        `INSERT INTO harness_next_selections(user_id,workspace_id,environment_id,session_id,thread_id,revision,selection_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT(user_id,workspace_id,environment_id,session_id,thread_id) DO UPDATE
        SET revision=EXCLUDED.revision,selection_json=EXCLUDED.selection_json`,
        [
          scope.userId,
          scope.workspaceId,
          scope.environmentId,
          params.sessionId,
          params.threadId,
          next,
          params.selection === null ? null : JSON.stringify(params.selection),
        ],
      );
      const response = HarnessSelectionResponseSchema.parse({
        workspaceId: scope.workspaceId,
        environmentId: scope.environmentId,
        sessionId: params.sessionId,
        threadId: params.threadId,
        revision: next,
        selection: params.selection,
      });
      await saveReceipt(
        tx,
        scope,
        "select",
        conversationKey(params),
        params.clientCommandId,
        fp,
        response,
      );
      return response;
    });
  }
  /** Uses the canonical admission caller's already-locked session/admission transaction. */
  async captureAdmissionSelection(
    tx: SqlClient,
    input: {
      scope: HarnessControlPlaneScope;
      sessionId: string;
      threadId: string;
      turnId: string;
      capture: HarnessAdmissionSelection;
      requestFingerprint: string;
      admitted: boolean;
    },
  ): Promise<void> {
    const capture = HarnessAdmissionSelectionSchema.parse(input.capture);
    if (capture.environmentId !== input.scope.environmentId)
      fail("admission_conflict", "Capture environment mismatch");
    const r = await tx.query<{ harness_admission_receipt_json: unknown }>(
      "SELECT harness_admission_receipt_json FROM canonical_turn_admissions WHERE turn_id=$1 FOR UPDATE",
      [input.turnId],
    );
    if (!r.rows[0]) fail("admission_conflict", "Reserved admission missing");
    const prior = r.rows[0].harness_admission_receipt_json;
    if (prior != null) {
      const saved = json(prior) as {
        capture: unknown;
        requestFingerprint: unknown;
      };
      if (
        saved.requestFingerprint !== input.requestFingerprint ||
        createStableEventFingerprint(saved.capture) !==
          createStableEventFingerprint(capture)
      )
        fail("admission_conflict", "Frozen admission selection changed");
      return;
    }
    if (input.admitted)
      fail(
        "admission_conflict",
        "Admitted harness receipt missing; recovery required",
      );
    const selected = selectionResponse(
      {
        workspaceId: input.scope.workspaceId,
        environmentId: input.scope.environmentId,
        sessionId: input.sessionId,
        threadId: input.threadId as HarnessSelectionReadRequest["threadId"],
      },
      await selectionRow(tx, input.scope, input, true),
    );
    if (
      selected.revision !== capture.selectionRevision ||
      createStableEventFingerprint(selected.selection) !==
        createStableEventFingerprint(capture.selection)
    )
      fail(
        "revision_conflict",
        "Harness selection changed before canonical admission",
      );
    let authOwnerGeneration: number | null = null;
    if (capture.selection) {
      const instance = await readInstance(
        tx,
        input.scope,
        capture.selection.instanceId,
        true,
      );
      if (
        !instance ||
        instance.harness !== capture.selection.harness ||
        instance.connectionId !== capture.selection.connectionId
      )
        fail(
          "instance_binding_conflict",
          "Selected configured instance changed",
        );
      await activeConnection(
        tx,
        input.scope,
        instance.connectionId,
        instance.authOwnerGeneration,
      );
      authOwnerGeneration = instance.authOwnerGeneration;
    }
    await tx.query(
      "UPDATE canonical_turn_admissions SET harness_admission_receipt_json=$2::jsonb WHERE turn_id=$1",
      [
        input.turnId,
        JSON.stringify({
          capture,
          authOwnerGeneration,
          requestFingerprint: input.requestFingerprint,
          binding: null,
        }),
      ],
    );
  }
}
function assertScope(
  scope: HarnessControlPlaneScope,
  params: { workspaceId: string; environmentId: string },
): void {
  if (
    !scope.userId ||
    scope.workspaceId !== params.workspaceId ||
    scope.environmentId !== params.environmentId
  )
    fail("not_found", "Harness scope does not match authenticated context");
}
async function ownedWorkspace(
  tx: SqlClient,
  scope: HarnessControlPlaneScope,
): Promise<void> {
  const r = await tx.query(
    "SELECT id FROM workspaces WHERE id::text=$1 AND user_id::text=$2",
    [scope.workspaceId, scope.userId],
  );
  if (!r.rows[0]) fail("not_found", "Owned workspace was not found");
}
async function ownedConversation(
  tx: SqlClient,
  scope: HarnessControlPlaneScope,
  p: { sessionId: string; threadId: string },
  exclusive: boolean,
): Promise<void> {
  const r = await tx.query(
    `SELECT id FROM sessions WHERE id::text=$1 AND user_id::text=$2 AND workspace_id::text=$3 AND thread_id=$4${exclusive ? " FOR UPDATE" : ""}`,
    [p.sessionId, scope.userId, scope.workspaceId, p.threadId],
  );
  if (!r.rows[0])
    fail("not_found", "Owned canonical conversation was not found");
}
async function activeConnection(
  tx: SqlClient,
  scope: HarnessControlPlaneScope,
  id: string,
  generation: number,
): Promise<void> {
  const r = await tx.query(
    "SELECT id FROM provider_credentials WHERE id::text=$1 AND user_id::text=$2 AND auth_owner_generation=$3 AND status='connected' AND deleted_at IS NULL AND refresh_claim_id IS NULL FOR SHARE",
    [id, scope.userId, generation],
  );
  if (!r.rows[0])
    fail("connection_unavailable", "Selected connection is unavailable");
}
async function readInstance(
  tx: SqlClient,
  s: HarnessControlPlaneScope,
  id: string,
  exclusive: boolean,
): Promise<StoredHarnessInstance | null> {
  const r = await tx.query<InstanceRow>(
    `SELECT * FROM harness_configured_instances WHERE user_id::text=$1 AND workspace_id=$2 AND environment_id=$3 AND instance_id=$4${exclusive ? " FOR UPDATE" : ""}`,
    [s.userId, s.workspaceId, s.environmentId, id],
  );
  return r.rows[0] ? mapInstance(r.rows[0]) : null;
}
function mapInstance(r: InstanceRow): StoredHarnessInstance {
  if (!["codex", "claude", "opencode"].includes(r.harness))
    fail("instance_binding_conflict", "Stored harness kind is invalid");
  return {
    userId: r.user_id,
    workspaceId: r.workspace_id,
    environmentId: r.environment_id,
    instanceId: r.instance_id,
    harness: r.harness as HarnessKind,
    connectionId: r.connection_id,
    authOwnerGeneration: number(r.auth_owner_generation),
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}
function instanceFromJson(value: unknown): StoredHarnessInstance {
  const r = value as StoredHarnessInstance;
  if (
    !r ||
    typeof r.userId !== "string" ||
    typeof r.instanceId !== "string" ||
    !["codex", "claude", "opencode"].includes(r.harness)
  )
    fail("command_conflict", "Stored setup receipt is invalid");
  safeRevision(r.authOwnerGeneration);
  return r;
}
async function selectionRow(
  tx: SqlClient,
  s: HarnessControlPlaneScope,
  p: { sessionId: string; threadId: string },
  exclusive: boolean,
): Promise<SelectionRow | null> {
  const r = await tx.query<SelectionRow>(
    `SELECT revision,selection_json FROM harness_next_selections WHERE user_id::text=$1 AND workspace_id=$2 AND environment_id=$3 AND session_id::text=$4 AND thread_id=$5${exclusive ? " FOR UPDATE" : ""}`,
    [s.userId, s.workspaceId, s.environmentId, p.sessionId, p.threadId],
  );
  return r.rows[0] ?? null;
}
function selectionResponse(
  p: HarnessSelectionReadRequest,
  r: SelectionRow | null,
): HarnessSelectionResponse {
  return HarnessSelectionResponseSchema.parse({
    ...p,
    revision: r ? number(r.revision) : 0,
    selection:
      r?.selection_json == null
        ? null
        : HarnessNextSelectionSchema.parse(json(r.selection_json)),
  });
}
function conversationKey(p: { sessionId: string; threadId: string }): string {
  return JSON.stringify([p.sessionId, p.threadId]);
}
async function lock(tx: SqlClient, key: unknown): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    createStableEventFingerprint(key),
  ]);
}
async function receipt(
  tx: SqlClient,
  s: HarnessControlPlaneScope,
  op: string,
  key: string,
  id: string,
  fp: string,
): Promise<unknown | null> {
  const r = await tx.query<{
    request_fingerprint: string;
    response_json: unknown;
  }>(
    "SELECT request_fingerprint,response_json FROM harness_control_command_receipts WHERE user_id::text=$1 AND workspace_id=$2 AND environment_id=$3 AND operation=$4 AND scope_id=$5 AND command_id=$6",
    [s.userId, s.workspaceId, s.environmentId, op, key, id],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.request_fingerprint !== fp)
    fail(
      "command_conflict",
      "Harness command ID was reused with changed content",
    );
  return json(row.response_json);
}
async function saveReceipt(
  tx: SqlClient,
  s: HarnessControlPlaneScope,
  op: string,
  key: string,
  id: string,
  fp: string,
  response: unknown,
): Promise<void> {
  await tx.query(
    "INSERT INTO harness_control_command_receipts(user_id,workspace_id,environment_id,operation,scope_id,command_id,request_fingerprint,response_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [
      s.userId,
      s.workspaceId,
      s.environmentId,
      op,
      key,
      id,
      fp,
      JSON.stringify(response),
    ],
  );
}
function json(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}
function safeRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("revision_conflict", "Harness revision is invalid");
}
function number(value: string | number): number {
  const n = Number(value);
  safeRevision(n);
  return n;
}
function fail(
  code: ConstructorParameters<typeof HarnessControlPlaneConflictError>[0],
  message: string,
): never {
  throw new HarnessControlPlaneConflictError(code, message);
}
