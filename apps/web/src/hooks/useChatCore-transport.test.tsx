import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatCore } from "./useChatCore";
import type { SubmissionOutcome } from "./chat/submissionAttemptRegistry";

const FIXTURE = {
  sessionId: "d1137b54-39df-4f38-b012-478018630ace",
  runId: "run_transport_fixture01",
  workspaceId: "d1137b54-39df-4f38-b012-478018630ace",
  threadId: "thr_transport_fixture01",
  turnId: "trn_transport_fixture01",
  runAttemptId: "attempt_transport_fixture01",
};

const { followTurnLifecycle, selectedModel } = vi.hoisted(() => ({
  followTurnLifecycle: vi.fn(async function* () {}),
  selectedModel: { value: "gpt-fixture" },
}));

vi.mock("./useProviderStore.js", () => ({
  useProviderStore: () => ({
    status: "ready",
    credentials: [{ id: "credential_fixture" }],
    selectedProviderId: "openai",
    selectedCredentialId: "credential_fixture",
    get selectedModelId() { return selectedModel.value; },
    lastResolvedConfig: null,
    providerModels: {},
    manageProviderModels: {},
    resolveForChat: vi.fn(),
  }),
}));

vi.mock("../services/api/lifecycleClient", () => ({
  createLifecycleClient: () => ({
    followTurnLifecycle,
    replayLifecycleEvents: vi.fn(async () => ({ events: [], nextSequence: null })),
    interruptTurn: vi.fn(async () => ({
      runId: FIXTURE.runId,
      accepted: true,
      status: "interrupt_requested",
      terminalEvent: terminalEvent(),
    })),
    startTurn: vi.fn(),
  }),
}));

// Transport tests use the actual SDK and real projection/loading logic. Only
// canonical projection fetching is held empty for these transport outcomes.
vi.mock("./useTurnLifecycleProjection.js", () => ({
  useTurnLifecycleProjection: () => ({ projection: null }),
}));

function terminalEvent() {
  return {
    eventId: "evt_transport_fixture01",
    sequence: 1,
    type: "turn.interrupted",
    threadId: FIXTURE.threadId,
    turnId: FIXTURE.turnId,
    runAttemptId: FIXTURE.runAttemptId,
    createdAt: "2026-10-04T00:00:00.000Z",
    schemaVersion: 1,
    idempotencyKey: "event_transport_fixture01",
    producer: { kind: "runtime_kernel", id: "fixture" },
    payload: {},
  };
}
function installServer(
  chat: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    requests.push({ url, method, body });
    if (url.includes("/turn/scope?")) {
      return new Response("scope unavailable", { status: 404 });
    }
    if (url.endsWith("/turn/start")) {
      return Response.json({
        workspaceId: FIXTURE.workspaceId,
        threadId: FIXTURE.threadId,
        turnId: FIXTURE.turnId,
        runAttemptId: FIXTURE.runAttemptId,
      });
    }
    if (url.endsWith("/chat")) return chat(input, init);
    throw new Error(`Unexpected request: ${method} ${url}`);
  }));
  return requests;
}

function renderCore(runId = `${FIXTURE.runId}_${crypto.randomUUID()}`) {
  return renderHook(({ currentRunId }: { currentRunId: string }) =>
    useChatCore(FIXTURE.sessionId, currentRunId), {
      initialProps: { currentRunId: runId },
    });
}

async function append(core: ReturnType<typeof renderCore>["result"], input: {
  content: string;
  id?: string;
  revisionTarget?: string;
}) {
  let outcome!: SubmissionOutcome;
  await act(async () => {
    if (input.revisionTarget) {
      const accepted = await core.current.reviseTurn(input.revisionTarget, input.content);
      outcome = accepted
        ? { status: "accepted", scope: core.current.scope! }
        : { status: "unconfirmed", scope: core.current.scope ?? undefined, message: core.current.error ?? "not accepted" };
    } else {
      outcome = await core.current.append({
          role: "user",
          content: input.content,
          ...(input.id ? { id: input.id } : {}),
        });
    }
  });
  return outcome;
}

describe("useChatCore installed SDK request outcomes", () => {
  beforeEach(() => {
    selectedModel.value = "gpt-fixture";
    followTurnLifecycle.mockReset();
    followTurnLifecycle.mockImplementation(async function* () {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a 503 unconfirmed and preserves composer input although SDK append resolves", async () => {
    const requests = installServer(async () => new Response("upstream unavailable", { status: 503 }));
    const { result } = renderCore();
    act(() => result.current.handleInputChange({ target: { value: "Keep this intent" } } as never));
    let submitted!: boolean;
    await act(async () => { submitted = await result.current.handleSubmit(); });

    expect(requests.some(({ url, method }) => url.endsWith("/turn/start") && method === "POST")).toBe(true);
    expect(requests.some(({ url, method }) => url.endsWith("/chat") && method === "POST")).toBe(true);
    expect(submitted).toBe(false);
    expect(result.current.error).toMatch(/503/);
    expect(result.current.input).toBe("Keep this intent");
    expect(result.current.isLoading).toBe(false);

    const firstWire = requests.find(({ url }) => url.endsWith("/chat"))?.body;
    await act(async () => { submitted = await result.current.handleSubmit(); });
    const chatRequests = requests.filter(({ url }) => url.endsWith("/chat"));
    expect(submitted).toBe(false);
    expect(result.current.input).toBe("Keep this intent");
    expect(result.current.isLoading).toBe(false);
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1]?.body).toBe(firstWire);
    expect(requests.filter(({ url, method }) => url.endsWith("/turn/start") && method === "POST")).toHaveLength(1);
  });

  it("reuses the reserved scope and exact emitted wire for an unchanged same-CID retry after a run reset", async () => {
    const requests = installServer(async () => new Response("upstream unavailable", { status: 503 }));
    const { result, rerender } = renderCore();
    const original = { role: "user" as const, content: "same payload", id: "client_msg_retry_transport01" };
    const first = await append(result, original);
    const firstWire = requests.find(({ url }) => url.endsWith("/chat"))?.body;
    rerender({ currentRunId: "run_transport_changed02" });
    const second = await append(result, original);
    const chatRequests = requests.filter(({ url }) => url.endsWith("/chat"));
    const starts = requests.filter(({ url }) => url.endsWith("/turn/start") && url.includes("/turn/start"));

    expect(first.status).toBe("unconfirmed");
    expect(second.status).toBe("unconfirmed");
    expect(chatRequests).toHaveLength(2);
    expect(chatRequests[1]?.body).toBe(firstWire);
    expect(starts).toHaveLength(1);
  });

  it("allocates one new CID for changed intent with a supplied queue CID, then freezes that CID on retry", async () => {
    const requests = installServer(async () => new Response("upstream unavailable", { status: 503 }));
    const { result, rerender } = renderCore();
    const suppliedId = "client_msg_setup_stable01";
    const first = await append(result, { id: suppliedId, content: "original setup intent" });
    selectedModel.value = "gpt-changed-model";
    rerender({ currentRunId: FIXTURE.runId });
    const changed = await append(result, { id: suppliedId, content: "changed setup intent" });
    const retry = await append(result, { id: suppliedId, content: "changed setup intent" });
    const starts = requests.filter(({ url }) => url.endsWith("/turn/start") && url.includes("/turn/start"));
    const chatRequests = requests.filter(({ url }) => url.endsWith("/chat"));
    const cids = chatRequests.map(({ body }) => {
      const parsed = body ? JSON.parse(body) as { clientMessageId: string } : null;
      return parsed?.clientMessageId;
    });

    expect(first.status).toBe("unconfirmed");
    expect(changed.status).toBe("unconfirmed");
    expect(retry.status).toBe("unconfirmed");
    expect(cids[0]).toBe(suppliedId);
    expect(cids[1]).not.toBe(suppliedId);
    expect(cids[2]).toBe(cids[1]);
    expect(chatRequests[2]?.body).toBe(chatRequests[1]?.body);
    expect(starts).toHaveLength(2);
  });
});
