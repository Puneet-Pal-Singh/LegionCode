import { describe, expect, it, vi } from "vitest";
import type {
  LifecycleClient,
  LifecycleEvent,
  TurnId,
} from "../../services/api/lifecycleClient";
import { hasCanonicalLifecycleEvidence } from "./resolveChatTransportFailure";

const TURN_ID = "trn_transport001" as TurnId;
const SCOPE = {
  workspaceId: "wsp_transport001",
  threadId: "thr_transport001",
  turnId: TURN_ID,
  runAttemptId: "attempt_transport001",
  sessionId: "ses_transport001",
  runId: "run_transport001",
} as const;

describe("hasCanonicalLifecycleEvidence", () => {
  it("treats the first replayed lifecycle event as accepted run evidence", async () => {
    const event = {
      id: "evt_transport001",
      threadId: SCOPE.threadId,
      sequence: 1,
      type: "turn.started",
      turnId: TURN_ID,
      runAttemptId: SCOPE.runAttemptId,
      occurredAt: "2026-07-28T00:00:00.000Z",
      payload: {},
    } as unknown as LifecycleEvent;
    const lifecycleClient = {
      followTurnLifecycle: vi.fn(async function* () {
        yield event;
      }),
    } as unknown as LifecycleClient;

    await expect(
      hasCanonicalLifecycleEvidence(lifecycleClient, SCOPE),
    ).resolves.toBe(true);
  });

  it("does not hide a transport failure when canonical replay has no evidence", async () => {
    const lifecycleClient = {
      followTurnLifecycle: vi.fn(async function* () {
        yield* [];
        return;
      }),
    } as unknown as LifecycleClient;

    await expect(
      hasCanonicalLifecycleEvidence(lifecycleClient, SCOPE),
    ).resolves.toBe(false);
  });

  it("continues past another attempt until it finds exact canonical evidence", async () => {
    const wrongAttempt = { ...eventFor(SCOPE), runAttemptId: "attempt_other001" };
    const exactAttempt = eventFor(SCOPE);
    const lifecycleClient = {
      followTurnLifecycle: vi.fn(async function* () {
        yield wrongAttempt;
        yield exactAttempt;
      }),
    } as unknown as LifecycleClient;

    await expect(hasCanonicalLifecycleEvidence(lifecycleClient, SCOPE)).resolves.toBe(true);
  });

  it("rejects events from a different thread, turn, or attempt", async () => {
    const lifecycleClient = {
      followTurnLifecycle: vi.fn(async function* () {
        yield eventFor({ ...SCOPE, threadId: "thr_other001" });
        yield eventFor({ ...SCOPE, turnId: "trn_other001" });
        yield eventFor({ ...SCOPE, runAttemptId: "attempt_other001" });
      }),
    } as unknown as LifecycleClient;

    await expect(hasCanonicalLifecycleEvidence(lifecycleClient, SCOPE)).resolves.toBe(false);
  });

  it("settles at the deadline even when next and iterator cleanup never resolve", async () => {
    let signal: AbortSignal | undefined;
    const returnIterator = vi.fn(() => new Promise<IteratorResult<LifecycleEvent>>(() => undefined));
    const lifecycleClient = {
      followTurnLifecycle: vi.fn((_request, options) => {
        signal = options?.signal;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<LifecycleEvent>>(() => undefined),
            return: returnIterator,
          }),
        };
      }),
    } as unknown as LifecycleClient;

    await expect(hasCanonicalLifecycleEvidence(lifecycleClient, SCOPE, 10)).resolves.toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(returnIterator).toHaveBeenCalledOnce();
  });
});

function eventFor(scope: {
  threadId: string;
  turnId: string;
  runAttemptId: string;
}): LifecycleEvent {
  return {
    eventId: "evt_transport001",
    threadId: scope.threadId,
    sequence: 1,
    type: "turn.started",
    turnId: scope.turnId,
    runAttemptId: scope.runAttemptId,
    createdAt: "2026-07-28T00:00:00.000Z",
    schemaVersion: 1,
    idempotencyKey: "event_transport001",
    producer: { kind: "runtime_kernel", id: "fixture" },
    payload: {},
  } as unknown as LifecycleEvent;
}
