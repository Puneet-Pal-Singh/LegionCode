// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { LifecycleProjection } from "@legioncode/sdk";
import { createAppServerClient, createAppServerHttpTransport } from "@legioncode/sdk";
import {
  ChatRequestBodySchema, HostedSessionSchema, LifecycleEventSchema,
  TurnScopeBootstrapSchema, TurnDiffPayloadSchema,
  type ConversationHistoryMessage, type LifecycleEvent,
} from "@repo/platform-protocol";
import { useChatPresentation } from "./useChatPresentation.js";
import { useHostedNativeConversation } from "../hosted/useHostedNativeConversation.js";
import type { HostedNativeDraft } from "../hosted/hostedNativeConversation.js";

describe("useChatPresentation", () => {
  it("keeps the loading placeholder visible while a new task identity hydrates", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [
          {
            id: "stale-message",
            role: "assistant",
            content: "Previous task content",
          },
        ],
        conversationTurns: [],
        hasHydrated: false,
        isLoading: false,
        hasPendingApproval: false,
        hasStartedSession: true,
      }),
    );

    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.showSessionPlaceholder).toBe(true);
  });

  it("does not reveal a pending approval before the selected task hydrates", async () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [],
        conversationTurns: [],
        hasHydrated: false,
        isLoading: true,
        hasPendingApproval: true,
        hasStartedSession: true,
      }),
    );

    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.showSessionPlaceholder).toBe(true);

    // The mounted hosted controller consumes actual SDK envelopes/HTTP metadata.
    // StrictMode and a late old-account read must never expose another task.
    const old = hostedFixture();
    old.messages = [{ id: "old-private-message", role: "assistant", content: "Previous account content", createdAt: "2026-11-14T00:00:00.000Z" }];
    let releaseHistory!: () => void;
    old.historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    const next = hostedFixture();
    const controller = renderHook((props) => useHostedNativeConversation(props), {
      initialProps: old.options,
      wrapper: ({ children }: PropsWithChildren) => <StrictMode>{children}</StrictMode>,
    });
    await waitFor(() => expect(old.requests.some((request) => request.method === "session/history")).toBe(true));
    const staleSubmit = controller.result.current.submit;
    controller.rerender(next.options);
    expect(controller.result.current.messages).toEqual([]);
    await act(async () => { releaseHistory(); });
    await waitFor(() => expect(controller.result.current.historyReady).toBe(true));
    expect(controller.result.current.scope).toBeNull();
    expect(await staleSubmit(hostedDraft())).toEqual({ status: "inactive" });
    expect(old.requests.filter((request) => request.method === "turn/reserve")).toHaveLength(0);
    controller.unmount();

    const fixture = hostedFixture();
    let mounted = renderHook(() => useHostedNativeConversation(fixture.options));
    await waitFor(() => expect(mounted.result.current.canSubmit).toBe(true));
    const draft = hostedDraft();
    let outcome: Awaited<ReturnType<typeof mounted.result.current.submit>> | undefined;
    await act(async () => { outcome = await mounted.result.current.submit(draft); });
    expect(outcome).toMatchObject({ status: "unconfirmed" });
    expect(mounted.result.current.pendingDraft).toEqual(draft);
    expect(mounted.result.current.canSubmit).toBe(false);
    await expect(mounted.result.current.submit({ ...draft, prompt: "Different work" })).rejects.toThrow("unchanged");
    expect(fixture.submissions).toHaveLength(1);
    act(() => { mounted.result.current.reload(); });
    await waitFor(() => expect(mounted.result.current.scopeRecoveryError?.code).toBe("TURN_ADMISSION_RECOVERY_REQUIRED"));
    expect(mounted.result.current.historyReady).toBe(true);
    expect(mounted.result.current.canSubmit).toBe(false);
    mounted.unmount();
    mounted = renderHook(() => useHostedNativeConversation(fixture.options));
    await waitFor(() => expect(mounted.result.current.scopeRecoveryError?.code).toBe("TURN_ADMISSION_RECOVERY_REQUIRED"));
    expect(fixture.submissions).toHaveLength(1);

    // A manually retried frozen request is accepted by its four early headers,
    // even when the JSON response body fails after that acknowledgement.
    fixture.acknowledge = true;
    let releaseSubmission!: () => void;
    fixture.submissionGate = new Promise<void>((resolve) => { releaseSubmission = resolve; });
    let retry!: ReturnType<typeof mounted.result.current.submit>;
    act(() => { retry = mounted.result.current.submit(draft); });
    await waitFor(() => expect(fixture.submissions).toHaveLength(2));
    expect(fixture.submissions).toHaveLength(2);
    expect(fixture.submissions[0]).toBe(fixture.submissions[1]);
    expect(fixture.requests.filter((request) => request.method === "turn/reserve")).toHaveLength(1);
    await waitFor(() => expect(mounted.result.current.activeProjection?.pendingApproval?.approvalId).toBe("appr_hosted01"));
    const oldStop = mounted.result.current.stop;
    mounted.unmount();
    expect(fixture.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(0);
    await act(async () => { releaseSubmission(); outcome = await retry; });
    expect(outcome).toMatchObject({ status: "accepted", scope: fixture.scope });

    const reopened = renderHook((props) => useHostedNativeConversation(props), { initialProps: fixture.options });
    await waitFor(() => expect(reopened.result.current.activeProjection?.pendingApproval?.approvalId).toBe("appr_hosted01"));
    expect(reopened.result.current.scope).toMatchObject(fixture.scope);
    expect(reopened.result.current.messages[0]).toMatchObject({ id: draft.id, content: draft.prompt });
    expect(fixture.submissions).toHaveLength(2);
    await act(async () => { await oldStop(); });
    expect(fixture.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(0);
    const approvalId = reopened.result.current.activeProjection!.pendingApproval!.approvalId;
    const staleDecision = reopened.result.current.decideApproval;
    await act(async () => { await reopened.result.current.decideApproval({ approvalId, decision: "approved" }); });
    await waitFor(() => expect(reopened.result.current.activeProjection?.pendingApproval).toBeNull());
    await expect(staleDecision({ approvalId, decision: "approved" })).rejects.toThrow("changed");
    await act(async () => { await reopened.result.current.stop(); });
    await waitFor(() => expect(reopened.result.current.activeProjection?.terminal?.state).toBe("interrupted"));
    const interrupt = fixture.requests.find((request) => request.method === "turn/interrupt");
    expect(interrupt?.params).toMatchObject({ ...fixture.scope, sessionId: fixture.options.session.id, runId: fixture.options.runId });
    await waitFor(() => expect(reopened.result.current.historyReady).toBe(true));
    await expect(reopened.result.current.readTurnDiff(fixture.scope.turnId)).resolves.toMatchObject({ diff: { turnId: fixture.scope.turnId } });

    let releaseReservation!: () => void;
    fixture.reserveGate = new Promise<void>((resolve) => { releaseReservation = resolve; });
    const nextDraft = hostedDraft();
    let nextSubmission!: ReturnType<typeof reopened.result.current.submit>;
    act(() => { nextSubmission = reopened.result.current.submit(nextDraft); });
    await waitFor(() => expect(fixture.requests.filter((request) => request.method === "turn/reserve")).toHaveLength(2));
    expect(reopened.result.current.canStop).toBe(true);
    expect(reopened.result.current.conversationTurns.find((turn) => turn.userMessage?.id === nextDraft.id)?.turnId).toBeUndefined();
    await act(async () => { await reopened.result.current.stop(); releaseReservation(); outcome = await nextSubmission; });
    expect(outcome).toMatchObject({ status: "cancelled", admission: "not-dispatched" });
    expect(fixture.submissions).toHaveLength(2);
    expect(fixture.requests.filter((request) => request.method === "turn/interrupt")).toHaveLength(1);
    const staleDiff = reopened.result.current.readTurnDiff;
    reopened.rerender({ ...fixture.options, binding: { ...fixture.options.binding, generation: 2 } });
    expect(reopened.result.current.messages).toEqual([]);
    expect(reopened.result.current.scope).toBeNull();
    await expect(staleDiff(fixture.scope.turnId)).rejects.toThrow("terminal turn");
    await waitFor(() => expect(reopened.result.current.historyReady).toBe(true));
    expect(fixture.submissions).toHaveLength(2);
    reopened.unmount();

    const uncertainStop = hostedFixture();
    uncertainStop.acknowledge = true;
    uncertainStop.interruptFailure = true;
    let releaseAck!: () => void;
    uncertainStop.submissionGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const stopping = renderHook(() => useHostedNativeConversation(uncertainStop.options));
    await waitFor(() => expect(stopping.result.current.canSubmit).toBe(true));
    let interruptedSubmission!: ReturnType<typeof stopping.result.current.submit>;
    act(() => { interruptedSubmission = stopping.result.current.submit(hostedDraft()); });
    await waitFor(() => expect(stopping.result.current.activeProjection?.pendingApproval?.approvalId).toBe("appr_hosted01"));
    await act(async () => { await expect(stopping.result.current.stop()).rejects.toThrow(); });
    await act(async () => { releaseAck(); outcome = await interruptedSubmission; });
    expect(outcome).toMatchObject({ status: "cancelled", admission: "unconfirmed" });
    expect(stopping.result.current.deliveryError).not.toBeNull();
    expect(stopping.result.current.pendingDraft).not.toBeNull();
    expect(stopping.result.current.isStopping).toBe(false);
    stopping.unmount();
  }, 15_000);

  it("reveals an optimistically admitted prompt while canonical replay hydrates", () => {
    const userMessage = {
      id: "client_msg_pending",
      role: "user" as const,
      content: "Explain the failing test",
    };
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [userMessage],
        conversationTurns: [
          {
            key: "turn:client_msg_pending",
            userMessage,
            assistantMessages: [],
            turnId: undefined,
          },
        ],
        hasHydrated: false,
        isLoading: true,
        hasPendingApproval: false,
        hasStartedSession: true,
        hasImmediateUserSubmission: true,
      }),
    );

    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.showSessionPlaceholder).toBe(false);
    expect(result.current.chatEntries[0]).toMatchObject({
      kind: "message",
      message: {
        id: "client_msg_pending",
        role: "user",
        content: "Explain the failing test",
      },
    });
  });

  it("renders the submitted setup prompt instead of a centered session spinner", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [],
        conversationTurns: [],
        hasHydrated: false,
        isLoading: true,
        hasPendingApproval: false,
        hasStartedSession: true,
        initialPromptSubmission: {
          id: "setup-1",
          prompt: "Inspect the README",
          status: "queued",
        },
      }),
    );

    expect(result.current.showSessionPlaceholder).toBe(false);
    expect(result.current.isTranscriptHydrating).toBe(true);
    expect(result.current.chatEntries[0]).toMatchObject({
      kind: "message",
      message: { role: "user", content: "Inspect the README" },
    });
  });

  it("does not duplicate the setup prompt after the canonical chat projects it", () => {
    const userMessage = {
      id: "client_msg_setup-1",
      role: "user" as const,
      content: "Inspect the README",
    };
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [userMessage],
        conversationTurns: [
          {
            key: "turn:client_msg_setup-1",
            userMessage,
            assistantMessages: [],
            turnId: undefined,
          },
        ],
        hasHydrated: true,
        isLoading: true,
        hasPendingApproval: false,
        hasStartedSession: true,
        initialPromptSubmission: {
          id: "setup-1",
          prompt: "Inspect the README",
          status: "queued",
        },
      }),
    );

    expect(
      result.current.chatEntries.filter((entry) => entry.kind === "message"),
    ).toHaveLength(1);
  });

  it("does not duplicate an image-bearing setup prompt with structured content", () => {
    const userMessage = {
      id: "client_msg_setup-image",
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Inspect this screenshot" },
        {
          type: "image" as const,
          image: "data:image/png;base64,aGVsbG8=",
          mimeType: "image/png",
        },
      ],
    } as unknown as import("@ai-sdk/react").Message;
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [userMessage],
        conversationTurns: [
          {
            key: "turn:client_msg_setup-image",
            userMessage,
            assistantMessages: [],
            turnId: undefined,
          },
        ],
        hasHydrated: false,
        isLoading: true,
        hasPendingApproval: false,
        hasStartedSession: true,
        initialPromptSubmission: {
          id: "setup-image",
          prompt: "Inspect this screenshot",
          status: "queued",
        },
      }),
    );

    expect(
      result.current.chatEntries.filter((entry) => entry.kind === "message"),
    ).toHaveLength(1);
    expect(result.current.chatEntries[0]).toMatchObject({
      kind: "message",
      message: { id: "client_msg_setup-image" },
    });
  });

  it("keeps a canonical failed terminal visible instead of replacing it with a final-output placeholder", () => {
    const { result } = renderHook(() =>
      useChatPresentation({
        messages: [{ id: "user-1", role: "user", content: "Read the project" }],
        conversationTurns: [],
        hasHydrated: true,
        isLoading: false,
        hasPendingApproval: false,
        hasStartedSession: true,
        lifecycleProjection: failedProjection(),
      }),
    );

    expect(result.current.terminalViewModel).toMatchObject({
      state: "failed_runtime",
      content: "The workspace scope could not be established.",
    });
  });
});

function failedProjection(): LifecycleProjection {
  return {
    turnId: "trn_terminal_failure" as LifecycleProjection["turnId"],
    workspaceSnapshotState: "unknown",
    resumeSnapshotAvailable: null,
    workspaceSnapshotUnavailableReason: null,
    resumeUnavailableReason: null,
    phase: "failed",
    lastSequence: 3,
    items: [],
    hookAudits: [],
    pendingApproval: null,
    terminal: {
      state: "failed",
      eventId: "evt_terminal_failure",
      content: "The workspace scope could not be established.",
      errorCode: "WORKSPACE_SCOPE_MISMATCH",
      occurredAt: "2026-07-18T10:00:00.000Z",
    },
    turnDiff: null,
    activeThinking: false,
    assistantText: "",
    startedAt: "2026-07-18T09:59:59.000Z",
    settledAt: "2026-07-18T10:00:00.000Z",
    contextBudget: null,
    usage: null,
  };
}

function hostedDraft(): HostedNativeDraft {
  return { id: `client_msg_${crypto.randomUUID()}`, prompt: "Inspect the project", configuration: {
    providerId: "openai", modelId: "fixture-model", mode: "build", productMode: "ask_always",
  } };
}

function hostedFixture() {
  const stamp = "2026-11-14T00:00:00.000Z";
  const sessionId = crypto.randomUUID();
  const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
  const scope = TurnScopeBootstrapSchema.parse({
    workspaceId: crypto.randomUUID(), threadId: "thr_hosted01", turnId: "trn_hosted01", runAttemptId: "attempt_hosted01",
  });
  type Envelope = { protocolVersion: string; method: string; params: Record<string, unknown> };
  const state = {
    acknowledge: false,
    reserved: false,
    admitted: false,
    interruptFailure: false,
    historyGate: null as Promise<void> | null,
    submissionGate: null as Promise<void> | null,
    reserveGate: null as Promise<void> | null,
    messages: [] as ConversationHistoryMessage[],
    events: [] as LifecycleEvent[],
    submissions: [] as string[],
    requests: [] as Envelope[],
  };
  const event = (type: string, payload: unknown, extras = {}) => LifecycleEventSchema.parse({
    eventId: `evt_hosted${state.events.length + 1}`, threadId: scope.threadId, turnId: scope.turnId,
    runAttemptId: scope.runAttemptId, sequence: state.events.length + 1,
    idempotencyKey: `hosted.${state.events.length + 1}`, type, payload, createdAt: stamp,
    producer: { kind: "runtime_kernel", id: "hosted-fixture" }, schemaVersion: 1, ...extras,
  });
  const fetchImpl: typeof fetch = async (_input, init) => {
    expect(init?.credentials).toBe("include");
    const envelope = JSON.parse(String(init?.body)) as Envelope;
    state.requests.push(envelope);
    const success = (result: unknown) => new Response(JSON.stringify({
      protocolVersion: envelope.protocolVersion, method: envelope.method, ok: true, result,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    switch (envelope.method) {
      case "session/history":
        if (state.historyGate) await state.historyGate;
        return success({ messages: state.messages, snapshot: "1", nextCursor: null });
      case "session/workspaceContext":
        return success({ sessionId, workspaceId: scope.workspaceId, threadId: state.reserved ? scope.threadId : null,
          workspaceStatus: "active", repository: null, selectedBranch: null, runBranch: null });
      case "turn/scope":
        if (state.reserved && !state.admitted) return new Response(JSON.stringify({
          protocolVersion: envelope.protocolVersion, method: envelope.method, ok: false,
          error: { code: "conflict", statusCode: 409, operationCode: "TURN_ADMISSION_RECOVERY_REQUIRED", retryable: false,
            message: "Turn admission is reserved but prompt persistence has not completed" },
        }), { status: 409, headers: { "Content-Type": "application/json" } });
        return state.reserved ? success(scope) : new Response(JSON.stringify({
          protocolVersion: envelope.protocolVersion, method: envelope.method, ok: false,
          error: { code: "not_found", message: "No reserved turn" },
        }), { status: 404, headers: { "Content-Type": "application/json" } });
      case "turn/reserve":
        expect(envelope.params).toMatchObject({ sessionId, runId });
        if (state.reserveGate) await state.reserveGate;
        state.reserved = true;
        return success(scope);
      case "turn/submit": {
        state.submissions.push(String(init?.body));
        const request = ChatRequestBodySchema.parse(envelope.params);
        expect(request).toMatchObject({ identity: scope, harnessMode: "platform_owned", authMode: "api_key" });
        if (state.acknowledge) {
          state.admitted = true;
          state.events.push(event("turn.started", {}));
          state.events.push(event("approval.requested", { question: "Run the project check?", options: [
            { id: "allow_once", label: "Allow once", description: null },
          ] }, { itemId: "itm_hosted01", approvalId: "appr_hosted01" }));
          state.messages = [{ id: request.clientMessageId!, role: "user", content: "Inspect the project", createdAt: stamp,
            data: { metadata: { canonicalIdentity: scope } } }];
        }
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (state.acknowledge) Object.assign(headers, {
          "X-Run-Id": runId, "X-Thread-Id": scope.threadId, "X-Turn-Id": scope.turnId, "X-Run-Attempt-Id": scope.runAttemptId,
        });
        if (state.submissionGate) await state.submissionGate;
        return new Response("{broken-json", { status: 200, headers });
      }
      case "turn/lifecycleEvents":
        return success({ events: state.events.filter((item) => item.sequence > Number(envelope.params.afterSequence ?? 0)), nextSequence: null });
      case "turn/approval": {
        const decided = event("approval.decided", { status: "approved" }, { itemId: "itm_hosted01", approvalId: "appr_hosted01" });
        state.events.push(decided);
        return success(decided);
      }
      case "turn/interrupt": {
        expect(envelope.params).toMatchObject({ ...scope, sessionId, runId });
        if (state.interruptFailure) return new Response(JSON.stringify({
          protocolVersion: envelope.protocolVersion, method: envelope.method, ok: false,
          error: { code: "server_unavailable", message: "Stop settlement is unconfirmed" },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
        const terminal = event("turn.interrupted", { outcome: { status: "interrupted", reason: "User stopped the turn." } });
        state.events.push(terminal);
        return success({ runId, accepted: true, status: "settled", terminalEvent: terminal });
      }
      case "turn/diff": {
        const snapshot = { turnId: scope.turnId, snapshotKey: scope.turnId, treeId: "a".repeat(40), headSha: "b".repeat(40), capturedAt: stamp };
        return success({ diff: TurnDiffPayloadSchema.parse({ turnId: scope.turnId,
          startSnapshot: { ...snapshot, phase: "start" }, terminalSnapshot: { ...snapshot, phase: "terminal" }, files: [], patch: "",
        }) });
      }
      default: throw new Error(`Unexpected hosted operation: ${envelope.method}`);
    }
  };
  const client = createAppServerClient({ clientId: "hosted-controller-fixture", clientVersion: "0.1.0",
    transport: createAppServerHttpTransport({ baseUrl: "https://hosted.example.test", credentials: "include", fetchImpl }) });
  const options = { client, binding: { target: "production", accountId: `account-${sessionId}`, generation: 1 },
    runId, enabled: true, session: HostedSessionSchema.parse({
      id: sessionId, userId: `account-${sessionId}`, workspaceId: scope.workspaceId, threadId: null,
      taskId: sessionId, title: "Hosted task", titleSource: "user", repository: null, activeRunId: runId,
      mode: "build", status: "idle", pinnedAt: null, archivedAt: null, createdAt: stamp, updatedAt: stamp,
    }) };
  return Object.assign(state, { options, scope });
}

afterEach(cleanup);
