import type { ConversationScope } from "../conversationScope";

export type SubmissionOutcome =
  | { status: "accepted"; scope: ConversationScope }
  | { status: "unconfirmed"; scope?: ConversationScope; message: string }
  | {
      status: "cancelled";
      admission: "not-dispatched" | "unconfirmed" | "accepted";
      scope?: ConversationScope;
    }
  | { status: "inactive"; scope?: ConversationScope };

export interface SubmissionAttempt {
  readonly token: string;
  readonly sessionId: string;
  readonly originalRunId: string;
  readonly runScopeGeneration: number;
  readonly clientMessageId: string;
  readonly intentKey: string;
  intentFingerprint: string;
  scope: ConversationScope | null;
  wireBody: string | null;
  readonly hadPriorDispatch: boolean;
  dispatched: boolean;
  stopRequested: boolean;
  responseStatus: number | null;
  responseTupleMatches: boolean;
  transportError: string | null;
  active: boolean;
}

interface SubmissionRecord {
  readonly key: string;
  readonly intentKey: string;
  intentFingerprint: string;
  readonly clientMessageId: string;
  scope: ConversationScope | null;
  wireBody: string | null;
  attempt: SubmissionAttempt | null;
  outcome: SubmissionOutcome | null;
  retireWhenInactive: boolean;
}

const records = new Map<string, SubmissionRecord>();
const retryByIntent = new Map<string, string>();
const clientMessageOwners = new Map<string, string>();
const MAX_SETTLED_RECORDS = 512;

export function acquireSubmissionAttempt(input: {
  sessionId: string;
  runId: string;
  runScopeGeneration: number;
  clientMessageId?: string;
  intentKey: string;
  intentFingerprint: string;
}):
  | { attempt: SubmissionAttempt; reused: boolean; previousOutcome?: never }
  | { attempt: null; reused: true; previousOutcome: SubmissionOutcome }
  | null {
  if (!input.intentKey.startsWith("explicit:")) {
    retireAbandonedRetryPayloads(
      input.sessionId,
      input.intentKey,
      input.intentFingerprint,
    );
  }
  if (
    input.clientMessageId &&
    clientMessageOwners.has(input.clientMessageId) &&
    clientMessageOwners.get(input.clientMessageId) !== input.sessionId
  ) {
    return null;
  }
  const retryKey = retryKeyFor(input.sessionId, input.intentKey, input.intentFingerprint);
  const rememberedKey = retryByIntent.get(retryKey);
  let record = rememberedKey ? records.get(rememberedKey) : undefined;
  if (
    record &&
    record.intentFingerprint === input.intentFingerprint &&
    record.outcome?.status === "accepted"
  ) {
    return { attempt: null, reused: true, previousOutcome: record.outcome };
  }
  if (
    !record ||
    record.intentFingerprint !== input.intentFingerprint
  ) {
    let clientMessageId = input.clientMessageId ?? createClientMessageId();
    let key = `${input.sessionId}\u0000${clientMessageId}`;
    let existing = records.get(key);
    if (
      existing &&
      input.intentKey.startsWith("explicit:") &&
      isTerminalOutcome(existing.outcome)
    ) {
      return { attempt: null, reused: true, previousOutcome: existing.outcome! };
    }
    if (existing && existing.intentFingerprint !== input.intentFingerprint) {
      clientMessageId = createClientMessageId();
      key = `${input.sessionId}\u0000${clientMessageId}`;
      existing = undefined;
    }
    if (
      existing?.outcome?.status === "accepted"
    ) {
      return { attempt: null, reused: true, previousOutcome: existing.outcome };
    }
    record = existing ?? {
      key: `${input.sessionId}\u0000${clientMessageId}`,
      intentKey: input.intentKey,
      intentFingerprint: input.intentFingerprint,
      clientMessageId,
      scope: null,
      wireBody: null,
      attempt: null,
      outcome: null,
      retireWhenInactive: false,
    };
    records.set(record.key, record);
    clientMessageOwners.set(record.clientMessageId, input.sessionId);
    retryByIntent.set(retryKey, record.key);
  }

  if (record.attempt?.active) return null;
  const attempt: SubmissionAttempt = {
    token: crypto.randomUUID(),
    sessionId: input.sessionId,
    originalRunId: record.scope?.runId ?? input.runId,
    runScopeGeneration: input.runScopeGeneration,
    clientMessageId: record.clientMessageId,
    intentKey: record.intentKey,
    intentFingerprint: record.intentFingerprint,
    scope: record.scope,
    wireBody: record.wireBody,
    hadPriorDispatch: record.wireBody !== null,
    dispatched: false,
    stopRequested: false,
    responseStatus: null,
    responseTupleMatches: false,
    transportError: null,
    active: true,
  };
  record.attempt = attempt;
  record.outcome = null;
  return { attempt, reused: Boolean(record.scope) };
}

export function retainSubmissionReservation(
  attempt: SubmissionAttempt,
  scope: ConversationScope,
): void {
  const record = findRecord(attempt);
  if (!record) return;
  record.scope ??= scope;
  record.attempt!.scope = record.scope;
}

export function freezeSubmissionWireBody(
  attempt: SubmissionAttempt,
  wireBody: string,
): string {
  const record = findRecord(attempt);
  if (!record) return wireBody;
  record.wireBody ??= wireBody;
  attempt.wireBody = record.wireBody;
  return record.wireBody;
}

export function finishSubmissionAttempt(
  attempt: SubmissionAttempt,
  outcome: SubmissionOutcome,
): void {
  const record = findRecord(attempt);
  attempt.active = false;
  if (!record) return;
  record.outcome = outcome;
  if (record.retireWhenInactive) {
    attempt.wireBody = null;
    deleteSubmissionRecord(record.key, record);
    return;
  }
  const resolvedCancellation =
    outcome.status === "cancelled" && outcome.admission !== "unconfirmed";
  if (
    outcome.status === "accepted" ||
    resolvedCancellation
  ) {
    record.wireBody = null;
    attempt.wireBody = null;
    record.attempt = null;
    // The fingerprint includes message content and can include image bytes.
    // A terminal result needs only the small explicit-ID tombstone below.
    record.intentFingerprint = "";
  }
  // A new composer or revision intent after a settled outcome gets a fresh ID.
  // Explicit queue IDs remain tombstoned so a keyed remount cannot submit them
  // twice. A known pre-dispatch cancellation can be explicitly submitted again.
  if (outcome.status === "accepted" || resolvedCancellation) {
    retryByIntent.delete(retryKeyFor(attempt.sessionId, attempt.intentKey, attempt.intentFingerprint));
  }
  pruneSettledRecords();
}

export function findSubmissionAttempt(
  sessionId: string,
  clientMessageId: string,
): SubmissionAttempt | null {
  return records.get(`${sessionId}\u0000${clientMessageId}`)?.attempt ?? null;
}

export function retireSubmissionIntent(
  sessionId: string,
  clientMessageId: string,
): void {
  const sessionPrefix = `${sessionId}\u0000`;
  const explicitIntentKey = `explicit:${clientMessageId}`;
  for (const [recordKey, record] of records) {
    if (
      !recordKey.startsWith(sessionPrefix) ||
      (record.clientMessageId !== clientMessageId &&
        record.intentKey !== explicitIntentKey)
    ) {
      continue;
    }
    if (record.attempt?.active) {
      record.retireWhenInactive = true;
    } else {
      deleteSubmissionRecord(recordKey, record);
    }
  }
}

export function retireSessionSubmissionAttempts(sessionId: string): void {
  const sessionPrefix = `${sessionId}\u0000`;
  for (const [recordKey, record] of records) {
    if (!recordKey.startsWith(sessionPrefix)) continue;
    if (record.attempt?.active) {
      record.retireWhenInactive = true;
    } else {
      deleteSubmissionRecord(recordKey, record);
    }
  }
}

function findRecord(attempt: SubmissionAttempt): SubmissionRecord | undefined {
  const record = records.get(`${attempt.sessionId}\u0000${attempt.clientMessageId}`);
  return record?.attempt?.token === attempt.token ? record : undefined;
}

function createClientMessageId(): string {
  return `client_msg_${crypto.randomUUID()}`;
}

function retryKeyFor(sessionId: string, intentKey: string, fingerprint: string): string {
  return `${sessionId}\u0000${intentKey}\u0000${fingerprint}`;
}

function pruneSettledRecords(): void {
  let settledCount = 0;
  for (const record of records.values()) {
    if (!record.attempt?.active && isTerminalOutcome(record.outcome)) {
      settledCount += 1;
    }
  }
  for (const [recordKey, record] of records) {
    if (settledCount <= MAX_SETTLED_RECORDS) return;
    if (record.attempt?.active || !isTerminalOutcome(record.outcome)) continue;
    deleteSubmissionRecord(recordKey, record);
    settledCount -= 1;
  }
}

function retireAbandonedRetryPayloads(
  sessionId: string,
  intentKey: string,
  currentFingerprint: string,
): void {
  for (const [recordKey, record] of records) {
    if (
      !recordKey.startsWith(`${sessionId}\u0000`) ||
      record.intentKey !== intentKey ||
      record.intentFingerprint === currentFingerprint ||
      record.intentKey.startsWith("explicit:") ||
      record.attempt?.active
    ) {
      continue;
    }
    deleteSubmissionRecord(recordKey, record);
  }
}

function deleteSubmissionRecord(
  recordKey: string,
  record: SubmissionRecord,
): void {
  records.delete(recordKey);
  clientMessageOwners.delete(record.clientMessageId);
  for (const [retryKey, rememberedRecordKey] of retryByIntent) {
    if (rememberedRecordKey === recordKey) retryByIntent.delete(retryKey);
  }
}

function isTerminalOutcome(
  outcome: SubmissionOutcome | null,
): outcome is Extract<SubmissionOutcome, { status: "accepted" | "cancelled" }> {
  return (
    outcome?.status === "accepted" ||
    (outcome?.status === "cancelled" && outcome.admission !== "unconfirmed")
  );
}
