import { describe, expect, it, vi } from "vitest";
import {
  DefaultPlatformClient,
  createPlatformClient,
} from "./client.js";
import {
  PlatformClientContractError,
  PlatformClientOperationError,
} from "./errors.js";
import {
  TEST_IDS,
  createAppendRunEventRequest,
  createApprovalEvent,
  createArtifact,
  createApprovalRequest,
  createRun,
  createRunEvent,
  createRunRequest,
  createThread,
  createThreadRequest,
  createWorkspaceManifest,
} from "./test-fixtures.js";
import type { PlatformClientTransport } from "./types.js";
import type { AppendRunEventRequest } from "./types.js";
import type { RunEvent } from "@repo/platform-protocol";

function createTransport(
  overrides: Partial<PlatformClientTransport> = {},
): PlatformClientTransport {
  const baseTransport: PlatformClientTransport = {
    createThread: vi.fn(async () => createThread()),
    createRun: vi.fn(async () => createRun()),
    appendRunEvent: vi.fn(async () => createRunEvent()),
    attachRunStream: vi.fn(async function* () {
      yield createRunEvent();
    }),
    replayRunEvents: vi.fn(async () => ({
      events: [createRunEvent()],
      nextCursor: TEST_IDS.nextCursor,
    })),
    submitApproval: vi.fn(async () => createApprovalEvent()),
    getArtifact: vi.fn(async () => createArtifact()),
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

  it("validates appendRunEvent requests before transport", async () => {
    const transport = createTransport();
    const client = new DefaultPlatformClient(transport);
    const request = {
      ...createAppendRunEventRequest(),
      scopeId: "run_other123",
    } as unknown as AppendRunEventRequest;

    await expect(client.appendRunEvent(request)).rejects.toBeInstanceOf(
      PlatformClientContractError,
    );
    expect(transport.appendRunEvent).not.toHaveBeenCalled();
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
