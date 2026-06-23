import { describe, expect, it, vi } from "vitest";
import { DefaultPlatformClient, createPlatformClient } from "./client.js";
import {
  PlatformClientContractError,
  PlatformClientOperationError,
} from "./errors.js";
import {
  TEST_IDS,
  createApprovalEvent,
  createArtifact,
  createLifecycleEvent,
  createApprovalRequest,
  createRun,
  createRunEvent,
  createRunRequest,
  createThread,
  createThreadRequest,
  createTurn,
  createTurnDiff,
  createWorkspaceManifest,
} from "./test-fixtures.js";
import type { PlatformClientTransport } from "./types.js";
import type { RunEvent } from "@repo/platform-protocol";

function createTransport(
  overrides: Partial<PlatformClientTransport> = {},
): PlatformClientTransport {
  const baseTransport: PlatformClientTransport = {
    createThread: vi.fn(async () => createThread()),
    createRun: vi.fn(async () => createRun()),
    startTurn: vi.fn(async () => ({ run: createRun(), turn: createTurn() })),
    getThread: vi.fn(async () => createThread()),
    listThreads: vi.fn(async () => ({
      threads: [createThread()],
      nextCursor: TEST_IDS.nextCursor,
    })),
    getRun: vi.fn(async () => createRun()),
    attachRunStream: vi.fn(async function* () {
      yield createRunEvent();
    }),
    attachLifecycleStream: vi.fn(async function* () {
      yield createLifecycleEvent(2);
    }),
    replayRunEvents: vi.fn(async () => ({
      events: [createRunEvent()],
      nextCursor: TEST_IDS.nextCursor,
    })),
    replayLifecycleEvents: vi.fn(async () => ({
      events: [createLifecycleEvent(1)],
      nextSequence: 1,
    })),
    submitApproval: vi.fn(async () => createApprovalEvent()),
    submitLifecycleApproval: vi.fn(async () =>
      createLifecycleEvent(2, {
        type: "approval.decided",
        itemId: TEST_IDS.approvalItemId,
        approvalId: TEST_IDS.approvalId,
        payload: { decision: "approved" },
      }),
    ),
    submitUserInputResponse: vi.fn(async () =>
      createLifecycleEvent(2, {
        type: "user_input.responded",
        itemId: TEST_IDS.userInputItemId,
        requestId: "input_123456",
        payload: { response: { ok: true } },
      }),
    ),
    getTurnDiff: vi.fn(async () => ({ diff: createTurnDiff() })),
    getArtifact: vi.fn(async () => createArtifact()),
    listArtifacts: vi.fn(async () => ({
      artifacts: [createArtifact()],
      nextCursor: TEST_IDS.nextCursor,
    })),
    getWorkspaceManifest: vi.fn(async () => createWorkspaceManifest()),
  };
  return { ...baseTransport, ...overrides };
}

describe("DefaultPlatformClient", () => {
  it("exposes the V1 facade through createPlatformClient", async () => {
    const transport = createTransport();
    const client = createPlatformClient(transport);

    expect(client).toBeInstanceOf(DefaultPlatformClient);
    await expect(client.createThread(createThreadRequest())).resolves.toEqual(
      createThread(),
    );
  });

  it("passes normalized createRun requests to the transport", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);
    const request = createRunRequest();

    await client.createRun(request);

    expect(transport.createRun).toHaveBeenCalledWith(request, undefined);
  });

  it("starts turns through the server-authoritative lifecycle endpoint", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);
    const request = createRunRequest();

    await expect(client.startTurn(request)).resolves.toEqual({
      run: createRun(),
      turn: createTurn(),
    });
    expect(transport.startTurn).toHaveBeenCalledWith(request, undefined);
  });

  it("exposes typed read contracts without event append authority", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);

    await expect(client.getThread(TEST_IDS.threadId)).resolves.toEqual(
      createThread(),
    );
    await expect(client.getRun(TEST_IDS.runId)).resolves.toEqual(createRun());
    await expect(
      client.listThreads({ userId: TEST_IDS.userId }),
    ).resolves.toEqual({
      threads: [createThread()],
      nextCursor: TEST_IDS.nextCursor,
    });
    await expect(
      client.listArtifacts({ runId: TEST_IDS.runId }),
    ).resolves.toEqual({
      artifacts: [createArtifact()],
      nextCursor: TEST_IDS.nextCursor,
    });
    expect("appendRunEvent" in client).toBe(false);
  });

  it("parses run events from an attached stream", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);
    const events: RunEvent[] = [];

    for await (const event of client.attachRunStream({
      runId: TEST_IDS.runId,
    })) {
      events.push(event);
    }

    expect(events).toEqual([createRunEvent()]);
  });

  it("reconnects retryable streams from the last received cursor", async () => {
    let attempts = 0;
    const attachRunStream = vi.fn(async function* () {
      attempts += 1;
      if (attempts === 1) {
        yield createRunEvent();
        throw new PlatformClientOperationError(
          "NETWORK_ERROR",
          "disconnected",
          true,
        );
      }
      yield { ...createRunEvent(), cursor: TEST_IDS.nextCursor };
    }) as PlatformClientTransport["attachRunStream"] & ReturnType<typeof vi.fn>;
    const client = new DefaultPlatformClient(
      createTransport({ attachRunStream }),
    );

    const events = await readAll(
      client.attachRunStream(
        { runId: TEST_IDS.runId },
        { streamRetry: { maxAttempts: 2, delayMs: 0 } },
      ),
    );

    expect(events).toHaveLength(2);
    expect(attachRunStream).toHaveBeenLastCalledWith(
      { runId: TEST_IDS.runId, afterCursor: TEST_IDS.cursor },
      { streamRetry: { maxAttempts: 2, delayMs: 0 } },
    );
  });

  it("validates replay envelopes and events", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);

    const replay = await client.replayRunEvents({
      runId: TEST_IDS.runId,
      afterCursor: TEST_IDS.cursor,
      limit: 10,
    });

    expect(replay.events).toEqual([createRunEvent()]);
    expect(replay.nextCursor).toBe(TEST_IDS.nextCursor);
  });

  it("replays durable lifecycle events before attaching live continuation", async () => {
    const transport = createTransport({
      replayLifecycleEvents: vi.fn(async () => ({
        events: [createLifecycleEvent(1)],
        nextSequence: 1,
      })),
      attachLifecycleStream: vi.fn(async function* () {
        yield createLifecycleEvent(2);
      }),
    });
    const client = new DefaultPlatformClient(transport);

    const events = await readAll(
      client.followTurnLifecycle({ turnId: TEST_IDS.turnId }),
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(transport.attachLifecycleStream).toHaveBeenCalledWith(
      { turnId: TEST_IDS.turnId, afterSequence: 1 },
      undefined,
    );
  });

  it("ignores duplicate lifecycle events after replay", async () => {
    const duplicate = createLifecycleEvent(1);
    const transport = createTransport({
      replayLifecycleEvents: vi.fn(async () => ({
        events: [duplicate],
        nextSequence: 1,
      })),
      attachLifecycleStream: vi.fn(async function* () {
        yield duplicate;
        yield createLifecycleEvent(2);
      }),
    });
    const client = new DefaultPlatformClient(transport);

    const events = await readAll(
      client.followTurnLifecycle({ turnId: TEST_IDS.turnId }),
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("raises an explicit resync error on lifecycle sequence gaps", async () => {
    const transport = createTransport({
      replayLifecycleEvents: vi.fn(async () => ({
        events: [createLifecycleEvent(1)],
        nextSequence: 1,
      })),
      attachLifecycleStream: vi.fn(async function* () {
        yield createLifecycleEvent(3);
      }),
    });
    const client = new DefaultPlatformClient(transport);

    await expect(
      readAll(client.followTurnLifecycle({ turnId: TEST_IDS.turnId })),
    ).rejects.toMatchObject({
      code: "lifecycle_sequence_gap",
      expectedSequence: 2,
      receivedSequence: 3,
    });
  });

  it("submits canonical approval and user-input responses", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);

    await expect(
      client.submitLifecycleApproval({
        turnId: TEST_IDS.turnId,
        approvalId: TEST_IDS.approvalId,
        decision: "approved",
        decidedBy: TEST_IDS.userId,
        reason: "Looks good",
      }),
    ).resolves.toMatchObject({ type: "approval.decided" });
    await expect(
      client.submitUserInputResponse({
        turnId: TEST_IDS.turnId,
        requestId: "input_123456",
        respondedBy: TEST_IDS.userId,
        response: { value: "continue" },
      }),
    ).resolves.toMatchObject({ type: "user_input.responded" });
  });

  it("reads the immutable turn diff explicitly", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);

    await expect(
      client.getTurnDiff({ turnId: TEST_IDS.turnId }),
    ).resolves.toEqual(createTurnDiff());
  });

  it("normalizes transport failures into typed operation errors", async () => {
    const transport = createTransport({
      getWorkspaceManifest: vi.fn(async () => {
        throw new Error("transport failed");
      }),
    });
    const client = new DefaultPlatformClient(transport);

    await expect(
      client.getWorkspaceManifest(TEST_IDS.runId),
    ).rejects.toBeInstanceOf(PlatformClientOperationError);
  });

  it("fails fast on invalid server contracts", async () => {
    const transport = createTransport({
      submitApproval: vi.fn(async () => ({ type: "approval.decided" })),
    });
    const client = new DefaultPlatformClient(transport);

    await expect(
      client.submitApproval(createApprovalRequest()),
    ).rejects.toBeInstanceOf(PlatformClientContractError);
  });
});

async function readAll<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}
