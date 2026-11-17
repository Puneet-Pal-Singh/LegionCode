import { randomUUID } from "node:crypto";
import {
  HarnessSetupRequestSchema,
  HarnessStatusRequestSchema,
  HarnessSelectRequestSchema,
  HarnessSelectionReadRequestSchema,
  HarnessSelectionResponseSchema,
  HarnessNextSelectionSchema,
  HarnessAdmissionSelectionSchema,
  HarnessSelectionSchema,
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
import type { HarnessAdmissionReceipt } from "../turn-admissions/types.js";
import { ProviderIdSchema, type ProviderId, type CredentialSecret } from "@repo/shared-types";
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
export interface ResolveHarnessAdmissionSelectionInput {
  readonly scope: Readonly<HarnessControlPlaneScope>;
  readonly sessionId: string;
  readonly threadId: string;
  readonly capture: HarnessAdmissionSelection;
  /** Trusted server placement, not copied from the submitted capture. */
  readonly expectedEnvironmentId: string;
}
export interface HarnessAdmissionCredentialMetadata {
  readonly connectionId: string;
  readonly providerId: ProviderId;
  readonly credentialKind: CredentialSecret["type"];
  readonly authOwnerGeneration: number;
  readonly tokenMaterialVersion: number;
}
export type ResolvedHarnessAdmissionSelection = Readonly<{
  scope: Readonly<HarnessControlPlaneScope>;
  sessionId: string;
  threadId: HarnessSelectionReadRequest["threadId"];
  revision: number;
}> & (
  | Readonly<{ selection: null; instance: null; credential: null }>
  | Readonly<{
      selection: Readonly<NonNullable<HarnessAdmissionSelection["selection"]>>;
      instance: Readonly<StoredHarnessInstance>;
      credential: Readonly<HarnessAdmissionCredentialMetadata>;
    }>
);
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
  /** Scope-only metadata authorization on the caller's transaction; not execution proof. */
  async authorizeMetadataScopeWithin(
    tx: SqlClient,
    input: {
      readonly scope: Readonly<HarnessControlPlaneScope>;
      readonly expectedEnvironmentId: string;
    },
  ): Promise<void> {
    input = structuredClone(input);
    const scope = Object.freeze({ ...input.scope });
    const params = HarnessStatusRequestSchema.parse({
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
    });
    if (!input.expectedEnvironmentId || input.expectedEnvironmentId !== scope.environmentId)
      fail("admission_conflict", "Metadata environment mismatch");
    assertScope(scope, params);
    await ownedWorkspace(tx, scope, true);
  }
  async setupInstance(
    scope: HarnessControlPlaneScope,
    input: HarnessSetupRequest,
    connection: {
      connectionId: string;
      providerId: ProviderId;
      credentialKind: CredentialSecret["type"];
      ownerGeneration: number;
      tokenMaterialVersion: number;
    },
  ): Promise<StoredHarnessInstance> {
    scope = Object.freeze({ ...scope });
    connection = Object.freeze({ connectionId: connection.connectionId, providerId: connection.providerId,
      credentialKind: connection.credentialKind, ownerGeneration: connection.ownerGeneration,
      tokenMaterialVersion: connection.tokenMaterialVersion });
    const params = HarnessSetupRequestSchema.parse(input);
    assertScope(scope, params);
    if (params.connectionId !== connection.connectionId)
      fail("connection_unavailable", "Selected connection does not match");
    if (!ProviderIdSchema.safeParse(connection.providerId).success ||
        !["api_key", "oauth", "external_reference"].includes(connection.credentialKind) ||
        !Number.isSafeInteger(connection.ownerGeneration) || connection.ownerGeneration < 1 ||
        !Number.isSafeInteger(connection.tokenMaterialVersion) || connection.tokenMaterialVersion < 1)
      fail("connection_unavailable", "Selected connection metadata is invalid");
    const fp = createStableEventFingerprint({ params, connection });
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
      if (prior) {
        const stored = instanceFromJson(prior);
        if (stored.userId !== scope.userId || stored.workspaceId !== scope.workspaceId ||
            stored.environmentId !== scope.environmentId || stored.harness !== params.harness ||
            stored.connectionId !== params.connectionId || stored.authOwnerGeneration !== connection.ownerGeneration ||
            (params.instanceId !== undefined && stored.instanceId !== params.instanceId))
          fail("command_conflict", "Stored setup receipt differs from its scoped command");
        return stored;
      }
      const instanceId = params.instanceId ?? "harness_" + randomUUID();
      await lock(tx, ["harness-instance", scope, instanceId]);
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
      await activeConnection(
        tx,
        scope,
        connection.connectionId,
        connection.ownerGeneration,
        connection,
      );
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
    scope = Object.freeze({ ...scope });
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
    scope = Object.freeze({ ...scope });
    return this.client.transaction(async (tx) => {
      await ownedWorkspace(tx, scope);
      return readInstance(tx, scope, instanceId, false);
    });
  }
  async readSelection(
    scope: HarnessControlPlaneScope,
    input: HarnessSelectionReadRequest,
  ): Promise<HarnessSelectionResponse> {
    scope = Object.freeze({ ...scope });
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
    scope = Object.freeze({ ...scope });
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
    scope = Object.freeze({ ...scope });
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
  /** Caller owns this transaction. Resolve BEFORE custody/decryption: session,
   * workspace, selection, instance, then credential UPDATE lock. There is no
   * SHARE-to-UPDATE credential upgrade and no independent transaction here.
   * Returned metadata is not account/host verification or a launch capability. */
  async resolveAdmissionSelectionWithin(
    tx: SqlClient,
    input: ResolveHarnessAdmissionSelectionInput,
  ): Promise<ResolvedHarnessAdmissionSelection> {
    input = structuredClone(input);
    const scope = Object.freeze({ ...input.scope });
    const capture = HarnessAdmissionSelectionSchema.parse(input.capture);
    if (!input.expectedEnvironmentId || scope.environmentId !== input.expectedEnvironmentId ||
        capture.environmentId !== input.expectedEnvironmentId)
      fail("admission_conflict", "Capture environment mismatch");
    const params = HarnessSelectionReadRequestSchema.parse({
      workspaceId: scope.workspaceId, environmentId: scope.environmentId,
      sessionId: input.sessionId, threadId: input.threadId,
    });
    assertScope(scope, params);
    await ownedConversation(tx, scope, params, true, true);
    await ownedWorkspace(tx, scope, true);
    const row = await selectionRow(tx, scope, params, true);
    if (!row && (capture.selection !== null || capture.selectionRevision !== 0))
      fail("not_found", "Owned harness selection is not persisted");
    if (row) databaseVersion(row.revision, 0);
    const selected = selectionResponse(params, row);
    if (selected.revision !== capture.selectionRevision ||
        createStableEventFingerprint(selected.selection) !== createStableEventFingerprint(capture.selection))
      fail("revision_conflict", "Harness selection changed before canonical admission");
    const common = { scope, sessionId: params.sessionId, threadId: params.threadId, revision: selected.revision };
    if (selected.selection === null)
      return Object.freeze({ ...common, selection: null, instance: null, credential: null });
    const selection = Object.freeze(selected.selection);
    const stored = await readInstance(tx, scope, selection.instanceId, true);
    if (!stored || stored.harness !== selection.harness || stored.connectionId !== selection.connectionId)
      fail("instance_binding_conflict", "Selected configured instance changed");
    databaseVersion(stored.authOwnerGeneration, 1);
    const result = await tx.query<SqlRow>(
      `SELECT id::text AS connection_id,provider_id,credential_kind,auth_owner_generation,token_material_version
       FROM provider_credentials WHERE id::text=$1 AND user_id::text=$2
       AND auth_owner_generation=$3 AND status='connected' AND deleted_at IS NULL AND refresh_claim_id IS NULL FOR UPDATE`,
      [selection.connectionId, scope.userId, stored.authOwnerGeneration],
    );
    const credential = result.rows[0];
    if (!credential || credential.connection_id !== selection.connectionId)
      fail("connection_unavailable", "Selected connection is unavailable");
    const kind = credential.credential_kind;
    if (kind !== "api_key" && kind !== "oauth" && kind !== "external_reference")
      fail("connection_unavailable", "Selected credential kind is invalid");
    const provider = ProviderIdSchema.safeParse(credential.provider_id);
    if (!provider.success) fail("connection_unavailable", "Selected credential provider is invalid");
    const authOwnerGeneration = databaseVersion(credential.auth_owner_generation, 1);
    if (authOwnerGeneration !== stored.authOwnerGeneration)
      fail("connection_unavailable", "Selected credential generation changed");
    return Object.freeze({ ...common, selection, instance: Object.freeze(stored),
      credential: Object.freeze({ connectionId: selection.connectionId, providerId: provider.data,
        credentialKind: kind, authOwnerGeneration,
        tokenMaterialVersion: databaseVersion(credential.token_material_version, 1) }) });
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
      expectedEnvironmentId: string;
      requestFingerprint: string;
      admitted: boolean;
    },
  ): Promise<void> {
    input = structuredClone(input);
    const capture = HarnessAdmissionSelectionSchema.parse(input.capture);
    if (capture.environmentId !== input.scope.environmentId || capture.environmentId !== input.expectedEnvironmentId)
      fail("admission_conflict", "Capture environment mismatch");
    const r = await tx.query<{ harness_admission_receipt_json: unknown }>(
      "SELECT harness_admission_receipt_json FROM canonical_turn_admissions WHERE turn_id=$1 FOR UPDATE",
      [input.turnId],
    );
    if (!r.rows[0]) fail("admission_conflict", "Reserved admission missing");
    const prior = r.rows[0].harness_admission_receipt_json;
    if (prior != null) {
      const saved = parseHarnessAdmissionReceipt(prior);
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
    const resolved = await this.resolveAdmissionSelectionWithin(tx, {
      scope: input.scope, sessionId: input.sessionId, threadId: input.threadId,
      capture, expectedEnvironmentId: input.expectedEnvironmentId,
    });
    const authOwnerGeneration = resolved.credential?.authOwnerGeneration ?? null;
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
/** Validate the private receipt without re-resolving mutable configuration. */
export function parseHarnessAdmissionReceipt(value: unknown): HarnessAdmissionReceipt {
  let parsed: unknown;
  try { parsed = json(value); }
  catch { fail("admission_conflict", "Stored harness receipt is malformed"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("admission_conflict", "Stored harness receipt is malformed");
  const raw = parsed as Record<string, unknown>;
  const capture = HarnessAdmissionSelectionSchema.parse(raw.capture);
  if (typeof raw.requestFingerprint !== "string" || !raw.requestFingerprint)
    fail("admission_conflict", "Stored harness receipt fingerprint is missing");
  const generation = raw.authOwnerGeneration;
  let authOwnerGeneration: number | null;
  if (capture.selection === null) {
    if (generation !== null) fail("admission_conflict", "Stored harness receipt generation is invalid");
    authOwnerGeneration = null;
  } else {
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0)
      fail("admission_conflict", "Stored harness receipt generation is invalid");
    authOwnerGeneration = generation;
  }
  const binding = raw.binding === null ? null : HarnessSelectionSchema.parse(raw.binding);
  if (binding && (!capture.selection || binding.environmentId !== capture.environmentId ||
      binding.selectionRevision !== capture.selectionRevision || binding.authOwnerGeneration !== generation ||
      binding.harness !== capture.selection.harness || binding.instanceId !== capture.selection.instanceId ||
      binding.connectionId !== capture.selection.connectionId || binding.modelId !== capture.selection.modelId))
    fail("admission_conflict", "Stored harness binding differs from its capture");
  return { capture, authOwnerGeneration,
    requestFingerprint: raw.requestFingerprint, binding };
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
  activeAndLocked = false,
): Promise<void> {
  const r = await tx.query(
    `SELECT id FROM workspaces WHERE id::text=$1 AND user_id::text=$2${activeAndLocked ? " AND status='active' FOR SHARE" : ""}`,
    [scope.workspaceId, scope.userId],
  );
  if (!r.rows[0]) fail("not_found", "Owned workspace was not found");
}
async function ownedConversation(
  tx: SqlClient,
  scope: HarnessControlPlaneScope,
  p: { sessionId: string; threadId: string },
  exclusive: boolean,
  active = false,
): Promise<void> {
  const r = await tx.query(
    `SELECT id FROM sessions WHERE id::text=$1 AND user_id::text=$2 AND workspace_id::text=$3 AND thread_id=$4${active ? " AND archived_at IS NULL" : ""}${exclusive ? " FOR UPDATE" : ""}`,
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
  expected?: { providerId: ProviderId; credentialKind: CredentialSecret["type"]; tokenMaterialVersion: number },
): Promise<void> {
  const r = await tx.query(
    `SELECT id FROM provider_credentials WHERE id::text=$1 AND user_id::text=$2 AND auth_owner_generation=$3 AND status='connected' AND deleted_at IS NULL AND refresh_claim_id IS NULL${expected ? " AND provider_id=$4 AND credential_kind=$5 AND token_material_version=$6" : ""} FOR SHARE`,
    expected ? [id, scope.userId, generation, expected.providerId, expected.credentialKind, expected.tokenMaterialVersion]
      : [id, scope.userId, generation],
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

function databaseVersion(value: unknown, minimum: number): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)))
    fail("connection_unavailable", "Stored selection or credential version is invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    fail("connection_unavailable", "Stored selection or credential version is invalid");
  return parsed;
}
