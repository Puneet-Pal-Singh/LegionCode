import { describe, expect, it } from "vitest";

import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import {
  InterruptTurnRequestSchema,
  RunAttemptIdSchema,
  ThreadIdSchema,
  TurnIdSchema,
  WorkspaceScopeIdSchema,
} from "@repo/platform-protocol";
import {
  AppServerClientError,
  createAppServerClient,
  type AppServerRequest,
} from "./app-server-client.js";

describe("AppServerClient", () => {
  it("sends a validated versioned envelope and returns a validated result", async () => {
    const sent: AppServerRequest[] = [];
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: {
        request: async (envelope) => {
          sent.push(envelope);
          if (envelope.method === "turn/interrupt") {
            return {
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              method: "turn/interrupt",
              ok: true,
              result: {
                runId: "run_123456",
                accepted: true,
                status: "interrupt_requested",
              },
            };
          }
          if (envelope.method === "artifact/reviewLatest" || envelope.method === "artifact/reviewByMessage") {
            return {
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              method: envelope.method,
              ok: true,
              result: { source: null, status: 204 },
            };
          }
          if (envelope.method === "artifact/diff") {
            return {
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              method: "artifact/diff",
              ok: true,
              result: {
                artifactId: "550e8400-e29b-41d4-a716-446655440002",
                path: "src/example.ts",
                source: "artifact_patch",
                diff: { oldPath: "src/example.ts", newPath: "src/example.ts", hunks: [], isBinary: false, isNewFile: false, isDeleted: false },
              },
            };
          }
          return {
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "initialize",
            ok: true,
            result: {
              protocolVersion: APP_SERVER_PROTOCOL_VERSION,
              server: { id: "local", version: "0.1.0" },
              environment: "local",
              capabilities: [],
              unavailableCapabilities: [],
            },
          };
        },
      },
    });

    const response = await client.initialize(["workspace-selection-v1"]);

    expect(sent[0]).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "initialize",
      params: {
        client: { id: "desktop", version: "0.1.0" },
        requestedCapabilities: ["workspace-selection-v1"],
      },
    });
    expect(response.environment).toBe("local");

    const interruptRequest = InterruptTurnRequestSchema.parse({
      runId: "run_123456",
      workspaceId: "123e4567-e89b-42d3-a456-426614174111",
      sessionId: "session-123456",
      threadId: "thr_123456",
      turnId: "trn_123456",
      runAttemptId: "attempt_123456",
      reason: "User stopped the turn.",
    });
    await expect(client.interruptTurn(interruptRequest)).resolves.toMatchObject({
      accepted: true,
      status: "interrupt_requested",
    });
    expect(sent[1]).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "turn/interrupt",
      params: interruptRequest,
    });

    const artifactIdentity = {
      threadId: "thread-1",
      turnId: "turn-1",
      runAttemptId: "attempt-1",
      workspaceId: "workspace-1",
    };
    await expect(client.getLatestEditArtifactReviewSource({
      runId: "run-1", sessionId: "session-1", identity: artifactIdentity,
    })).resolves.toEqual({ source: null, status: 204 });
    await expect(client.getEditArtifactReviewSourceByMessage({
      runId: "run-1", assistantMessageId: "message-1", identity: artifactIdentity,
    })).resolves.toEqual({ source: null, status: 204 });
    await expect(client.getEditArtifactDiff({
      artifactId: "550e8400-e29b-41d4-a716-446655440002",
      path: "src/example.ts",
      identity: artifactIdentity,
    })).resolves.toMatchObject({ source: "artifact_patch", path: "src/example.ts" });
    expect(sent.slice(2)).toEqual([
      {
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method: "artifact/reviewLatest",
        params: { runId: "run-1", sessionId: "session-1", ...artifactIdentity },
      },
      {
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method: "artifact/reviewByMessage",
        params: { runId: "run-1", assistantMessageId: "message-1", ...artifactIdentity },
      },
      {
        protocolVersion: APP_SERVER_PROTOCOL_VERSION,
        method: "artifact/diff",
        params: { artifactId: "550e8400-e29b-41d4-a716-446655440002", path: "src/example.ts", ...artifactIdentity },
      },
    ]);
  });

  it("acknowledges a canonical terminal turn through the typed session operation", async () => {
    let sent: AppServerRequest | undefined;
    const sessionId = "550e8400-e29b-41d4-a716-446655440001";
    const client = createAppServerClient({
      clientId: "web",
      clientVersion: "0.1.0",
      transport: { request: async (envelope) => {
        sent = envelope;
        return {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          method: "session/readReceipt",
          ok: true,
          result: { sessionId, lastAcknowledgedTerminalTurnId: "trn_terminal123", acknowledgedAt: "2026-10-12T12:00:00.000Z" },
        };
      } },
    });
    await expect(client.acknowledgeSessionReadReceipt(sessionId, "trn_terminal123")).resolves.toEqual({
      sessionId, lastAcknowledgedTerminalTurnId: "trn_terminal123", acknowledgedAt: "2026-10-12T12:00:00.000Z",
    });
    expect(sent).toMatchObject({ method: "session/readReceipt", params: { sessionId, terminalTurnId: "trn_terminal123" } });
  });

  it("uses opaque workspace selection tokens and rejects invalid server results", async () => {
    let sent: AppServerRequest | undefined;
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: {
        request: async (envelope) => {
          sent = envelope;
          return {
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "workspace/grant",
            ok: true,
            result: { grant: null },
          };
        },
      },
    });

    await expect(client.grantWorkspace({ selectionToken: "selection-token" })).rejects.toMatchObject({
      code: "invalid_response",
    } satisfies Partial<AppServerClientError>);
    expect(sent).toEqual({
      protocolVersion: APP_SERVER_PROTOCOL_VERSION,
      method: "workspace/grant",
      params: { selectionToken: "selection-token" },
    });
  });

  it.each([
    { protocolVersion: "2.0.0", method: "initialize", ok: true, result: {} },
    { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "thread/list", ok: true, result: { threads: [] } },
    { protocolVersion: APP_SERVER_PROTOCOL_VERSION, method: "initialize", ok: true, result: { server: {} } },
  ])("rejects malformed, mismatched, or invalid operation responses", async (response) => {
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: { request: async () => response },
    });
    await expect(client.initialize()).rejects.toMatchObject({
      name: "AppServerClientError",
      code: "invalid_response",
    });
  });

  it("wraps transport failures in a typed client error", async () => {
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: { request: async () => { throw new Error("private transport detail"); } },
    });
    await expect(client.initialize()).rejects.toMatchObject({
      name: "AppServerClientError",
      code: "transport",
    } satisfies Partial<AppServerClientError>);
  });

  it("uses correlated App Server methods and validates provider catalog and selection results", async () => {
    const sent: AppServerRequest[] = [];
    const client = createAppServerClient({
      clientId: "desktop",
      clientVersion: "0.1.0",
      transport: {
        request: async (envelope) => {
          sent.push(envelope);
          const results: Record<string, unknown> = {
            "provider/catalog": { providers: [] },
            "provider/models": {
              providerId: "openai",
              view: "popular",
              models: [],
              page: { limit: 1, hasMore: false },
              metadata: { fetchedAt: "2026-10-04T00:00:00.000Z", stale: false, source: "registry", status: "available" },
            },
            "provider/current": { selection: null },
            "provider/select": { selection: { providerId: "openai", modelId: "gpt-4o" } },
            "provider/clear": { selection: null },
            "turn/resume": { status: "resumed", clientCommandId: "command-1", continuationOfTurnId: "trn_123456", originalPromptId: "prompt-1", turnId: "trn_654321", runAttemptId: "attempt_654321", runId: "run_123456" },
            "turn/steer": { status: "conflict", code: "target_superseded", message: "Changed" },
            "thread/input/enqueue": { status: "conflict", code: "queue_item_changed", message: "Changed" },
            "thread/input/list": { threadId: "thr_123456", workspaceId: "123e4567-e89b-42d3-a456-426614174111", revision: 0, paused: false, pauseReason: null, activeRunId: null, latestStarted: null, items: [] },
            "thread/input/update": { status: "conflict", code: "queue_item_changed", message: "Changed" },
            "thread/input/remove": { status: "conflict", code: "queue_item_changed", message: "Changed" },
            "thread/input/steer": { status: "conflict", code: "target_superseded", message: "Changed" },
            "thread/input/start": { status: "conflict", code: "queue_item_changed", message: "Changed" },
          };
          return {
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: envelope.method,
            ok: true,
            result: results[envelope.method],
          };
        },
      },
    });

    await expect(client.getProviderCatalog()).resolves.toEqual([]);
    await expect(client.getProviderModels("openai")).resolves.toMatchObject({ providerId: "openai", metadata: { source: "registry" } });
    await expect(client.getProviderSelection()).resolves.toBeNull();
    await expect(client.selectProvider("openai", "gpt-4o")).resolves.toEqual({ providerId: "openai", modelId: "gpt-4o" });
    await expect(client.clearProviderSelection()).resolves.toBeNull();
    const threadScope = {
      threadId: ThreadIdSchema.parse("thr_123456"),
      workspaceId: WorkspaceScopeIdSchema.parse("123e4567-e89b-42d3-a456-426614174111"),
    };
    const turnId = TurnIdSchema.parse("trn_123456");
    const runAttemptId = RunAttemptIdSchema.parse("attempt_123456");
    await client.resumeTurn({ operation: "turn.resume", ...threadScope, clientCommandId: "command-1", expectedTurnId: turnId, expectedRunAttemptId: runAttemptId, expectedTerminalSequence: 1 });
    await client.steerTurn({ operation: "turn.steer", ...threadScope, clientInputId: "input-1", expectedTurnId: turnId, expectedRunAttemptId: runAttemptId, content: { text: "hello", images: [] } });
    await client.enqueueThreadInput({ operation: "thread.input.enqueue", ...threadScope, clientInputId: "input-1", content: { text: "hello", images: [] }, configuration: {} });
    await client.listThreadInputs({ operation: "thread.input.list", ...threadScope });
    const itemId = "123e4567-e89b-42d3-a456-426614174222";
    await client.updateThreadInput({ operation: "thread.input.update", ...threadScope, itemId, expectedVersion: 1, content: { text: "hello" } });
    await client.removeThreadInput({ operation: "thread.input.remove", ...threadScope, itemId, expectedVersion: 1 });
    await client.steerQueuedThreadInput({ operation: "thread.input.steer", ...threadScope, itemId, expectedVersion: 1, expectedTurnId: turnId, expectedRunAttemptId: runAttemptId });
    await client.startQueuedThreadInput({ operation: "thread.input.start", ...threadScope, itemId, expectedVersion: 1, expectedThreadRevision: 1 });
    expect(sent.map(({ method }) => method)).toEqual([
      "provider/catalog",
      "provider/models",
      "provider/current",
      "provider/select",
      "provider/clear",
      "turn/resume",
      "turn/steer",
      "thread/input/enqueue",
      "thread/input/list",
      "thread/input/update",
      "thread/input/remove",
      "thread/input/steer",
      "thread/input/start",
    ]);
    expect(sent[3]).toMatchObject({ params: { providerId: "openai", modelId: "gpt-4o" } });
  });
});
