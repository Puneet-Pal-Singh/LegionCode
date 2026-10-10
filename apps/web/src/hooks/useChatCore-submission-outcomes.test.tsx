import { act, renderHook } from "@testing-library/react";
import {
  LifecycleEventSchema,
  type InterruptTurnRequest,
  type InterruptTurnResponse,
  type LifecycleEvent,
  type PlatformClientOperationOptions,
} from "@legioncode/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatCore } from "./useChatCore";

type Fixture = {
  sessionId: string;
  runId: string;
  workspaceId: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
};

const { state } = vi.hoisted(() => ({
  state: {
    fixture: null as Fixture | null,
    events: [] as LifecycleEvent[],
    followTurnLifecycle: vi.fn<[], AsyncGenerator<LifecycleEvent>>(
      async function* () {},
    ),
    interruptTurn: vi.fn<
      [InterruptTurnRequest, PlatformClientOperationOptions?],
      Promise<InterruptTurnResponse>
    >(async () => ({
      runId: "run_test01" as InterruptTurnResponse["runId"],
      accepted: true,
      status: "interrupt_requested",
      terminalEvent: null,
    })),
    selectedModelId: "gpt-submission-fixture",
    onResponseObserved: null as (() => void) | null,
  },
}));

type LifecycleEventFixture = {
  eventId: string;
  sequence: number;
  type: string;
  threadId: string;
  turnId: string;
  runAttemptId: string;
  createdAt: string;
  schemaVersion: number;
  idempotencyKey: string;
  producer: { kind: "runtime_kernel"; id: string };
  payload: Record<string, unknown>;
};

vi.mock("./useProviderStore.js", () => ({
  useProviderStore: () => ({
    status: "ready",
    credentials: [{ id: "credential_submission_fixture" }],
    selectedProviderId: "openai",
    selectedCredentialId: "credential_submission_fixture",
    get selectedModelId() {
      return state.selectedModelId;
    },
    lastResolvedConfig: null,
    providerModels: {},
    manageProviderModels: {},
    resolveForChat: vi.fn(),
  }),
}));

vi.mock("../services/api/lifecycleClient", () => ({
  createLifecycleClient: () => ({
    followTurnLifecycle: state.followTurnLifecycle,
    replayLifecycleEvents: vi.fn(async () => ({
      events: [],
      nextSequence: null,
    })),
    interruptTurn: state.interruptTurn,
    startTurn: vi.fn(),
  }),
}));

vi.mock("../lib/client-logger.js", () => ({
  logClientEvent: vi.fn((category: string, eventName: string) => {
    if (category === "chat/stream" && eventName === "response") {
      state.onResponseObserved?.();
    }
  }),
  logClientWarning: vi.fn(),
}));

// Keep useActiveTurnProjection and deriveCanonicalRunLoading real. The
// projection hook is held at its server boundary so the test does not depend
// on polling timing or share projection cache state across cases.
vi.mock("./useTurnLifecycleProjection.js", () => ({
  useTurnLifecycleProjection: () => ({ projection: null }),
}));

function fixture(name: string): Fixture {
  const suffix = name
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 12)
    .padEnd(12, "x");
  return {
    sessionId: crypto.randomUUID(),
    runId: `run_outcome_${suffix}`,
    workspaceId: crypto.randomUUID(),
    threadId: `thr_outcome_${suffix}`,
    turnId: `trn_outcome_${suffix}`,
    runAttemptId: `attempt_outcome_${suffix}`,
  };
}

function event(overrides: Partial<LifecycleEventFixture> = {}): LifecycleEvent {
  const current = state.fixture!;
  return LifecycleEventSchema.parse({
    eventId: "evt_submission_outcome01",
    sequence: 1,
    type: "turn.started",
    threadId: current.threadId,
    turnId: current.turnId,
    runAttemptId: current.runAttemptId,
    createdAt: "2026-10-05T00:00:00.000Z",
    schemaVersion: 1,
    idempotencyKey: "event_submission_outcome01",
    producer: { kind: "runtime_kernel", id: "submission-outcomes-test" },
    payload: { turnId: current.turnId },
    ...overrides,
  }) as LifecycleEvent;
}

function terminalEvent(overrides: Partial<LifecycleEventFixture> = {}) {
  return event({
    type: "turn.interrupted",
    payload: {
      outcome: { status: "interrupted", reason: "User stopped the turn." },
    },
    ...overrides,
  });
}

function acceptedInterrupt(
  terminal: LifecycleEvent | null = null,
): InterruptTurnResponse {
  return {
    runId: state.fixture!.runId as InterruptTurnResponse["runId"],
    accepted: true,
    status: "interrupt_requested",
    terminalEvent: terminal,
  };
}

function responseHeaders(
  current = state.fixture!,
  overrides: Record<string, string> = {},
) {
  return {
    "X-Run-Id": current.runId,
    "X-Thread-Id": current.threadId,
    "X-Turn-Id": current.turnId,
    "X-Run-Attempt-Id": current.runAttemptId,
    ...overrides,
  };
}

type RequestRecord = { url: string; method: string; body: string | null };

function installServer(
  chat: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  turnStart: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = async () =>
    Response.json({
      workspaceId: state.fixture!.workspaceId,
      threadId: state.fixture!.threadId,
      turnId: state.fixture!.turnId,
      runAttemptId: state.fixture!.runAttemptId,
    }),
) {
  const requests: RequestRecord[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : null;
      requests.push({ url, method, body });
      if (url.includes("/turn/scope?"))
        return new Response("not resumed", { status: 404 });
      if (url.endsWith("/turn/start")) return turnStart(input, init);
      if (url.endsWith("/chat")) return chat(input, init);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }),
  );
  return requests;
}

function renderCore(current = state.fixture!) {
  return renderHook(() => useChatCore(current.sessionId, current.runId));
}

async function append(
  core: ReturnType<typeof renderCore>["result"],
  content: string,
) {
  let outcome!: Awaited<ReturnType<typeof core.current.append>>;
  await act(async () => {
    outcome = await core.current.append({ role: "user", content });
  });
  return outcome;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

describe("useChatCore submission outcomes through the installed AI SDK", () => {
  beforeEach(() => {
    state.fixture = fixture(`case${crypto.randomUUID().replaceAll("-", "")}`);
    state.events = [];
    state.selectedModelId = "gpt-submission-fixture";
    state.onResponseObserved = null;
    state.followTurnLifecycle.mockReset();
    state.followTurnLifecycle.mockImplementation(async function* () {
      yield* state.events;
    });
    state.interruptTurn.mockReset();
    state.interruptTurn.mockImplementation(async () =>
      acceptedInterrupt(terminalEvent()),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns an ordinary submit failure for HTTP 503, restores input, clears loading, and permits explicit retry", async () => {
    const requests = installServer(
      async () => new Response("provider unavailable", { status: 503 }),
    );
    const { result } = renderCore();
    act(() =>
      result.current.handleInputChange({
        target: { value: "Keep this prompt" },
      } as never),
    );

    let first!: boolean;
    await act(async () => {
      first = await result.current.handleSubmit();
    });
    expect(first).toBe(false);
    expect(result.current.error).toMatch(/503/);
    expect(result.current.input).toBe("Keep this prompt");
    expect(result.current.isLoading).toBe(false);

    let retry!: boolean;
    await act(async () => {
      retry = await result.current.handleSubmit();
    });
    expect(retry).toBe(false);
    expect(requests.filter(({ url }) => url.endsWith("/chat"))).toHaveLength(2);
    expect(
      requests.filter(({ url }) => url.endsWith("/turn/start")),
    ).toHaveLength(1);
  });

  it("accepts a lost transport only after an exact thread, turn, and attempt lifecycle event", async () => {
    const requests = installServer(async () => {
      throw new TypeError("socket closed after admission");
    });
    state.events = [event()];
    const { result } = renderCore();
    const outcome = await append(
      result,
      "canonical acceptance survives transport loss",
    );
    const chat = requests.find(({ url }) => url.endsWith("/chat"));
    const body = chat?.body
      ? (JSON.parse(chat.body) as Record<string, unknown>)
      : {};
    const identity = body.identity as Record<string, unknown>;

    expect(outcome.status).toBe("accepted");
    expect(identity).toMatchObject({
      workspaceId: state.fixture!.workspaceId,
      threadId: state.fixture!.threadId,
      turnId: state.fixture!.turnId,
      runAttemptId: state.fixture!.runAttemptId,
    });
    expect(requests.filter(({ url }) => url.endsWith("/chat"))).toHaveLength(1);
  });

  it("keeps a network rejection unconfirmed when exact canonical evidence is absent", async () => {
    const requests = installServer(async () => {
      throw new TypeError("network disconnected");
    });
    const { result } = renderCore();
    const outcome = await append(
      result,
      "network failed without admission proof",
    );

    expect(outcome.status).toBe("unconfirmed");
    expect(requests.filter(({ url }) => url.endsWith("/chat"))).toHaveLength(1);
  });

  it("accepts a successful HTTP response only when all response tuple headers match", async () => {
    installServer(
      async () =>
        new Response("", {
          status: 200,
          headers: responseHeaders(state.fixture!, {
            "X-Run-Attempt-Id": "attempt_outcome_wrong",
          }),
        }),
    );
    const { result } = renderCore();
    const outcome = await append(result, "mismatched acknowledgement tuple");

    expect(outcome.status).toBe("unconfirmed");
  });

  it("accepts the exact successful HTTP tuple without requiring provider completion", async () => {
    installServer(
      async () =>
        new Response("", {
          status: 200,
          headers: responseHeaders(),
        }),
    );
    const { result } = renderCore();
    const outcome = await append(result, "exact admission acknowledgement");

    expect(outcome.status).toBe("accepted");
  });

  it("ignores wrong thread and attempt events, then accepts a later exact event for the reserved tuple", async () => {
    installServer(async () => {
      throw new TypeError("connection lost");
    });
    state.events = [
      event({
        threadId: "thr_outcome_otherthread",
        runAttemptId: state.fixture!.runAttemptId,
      }),
      event({
        threadId: state.fixture!.threadId,
        runAttemptId: "attempt_outcome_other",
      }),
      event(),
    ];
    const { result } = renderCore();
    const outcome = await append(result, "skip unrelated lifecycle events");

    expect(outcome.status).toBe("accepted");
  });

  it("does not accept ID-less or unrelated terminal events as Stop settlement", async () => {
    const requests = installServer(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    state.followTurnLifecycle.mockImplementation(async function* () {});
    const terminal = terminalEvent();
    const {
      threadId: _threadId,
      turnId: _turnId,
      runAttemptId: _runAttemptId,
      ...idlessTerminal
    } = terminal;
    void _threadId;
    void _turnId;
    void _runAttemptId;
    state.interruptTurn.mockImplementation(async () =>
      acceptedInterrupt(idlessTerminal as unknown as LifecycleEvent),
    );
    const { result } = renderCore();
    let outcomePromise!: ReturnType<typeof append>;
    await act(async () => {
      outcomePromise = result.current.append({
        role: "user",
        content: "uncertain then stopped",
      });
      await until(
        () => requests.some(({ url }) => url.endsWith("/chat")),
        "chat dispatch",
      );
      result.current.stop();
    });
    let outcome!: Awaited<typeof outcomePromise>;
    await act(async () => {
      outcome = await outcomePromise;
    });
    const chatRequest = requests.find(({ url }) => url.endsWith("/chat"));
    const requestBody = chatRequest?.body
      ? (JSON.parse(chatRequest.body) as Record<string, unknown>)
      : {};
    const identity = requestBody.identity as Record<string, unknown>;

    expect(outcome).toMatchObject({
      status: "cancelled",
      admission: "unconfirmed",
    });
    expect(state.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: state.fixture!.sessionId,
        runId: state.fixture!.runId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        runAttemptId: identity.runAttemptId,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(requests.filter(({ url }) => url.endsWith("/chat"))).toHaveLength(1);
  });

  it("cancels a reservation stopped before chat dispatch without sending or interrupting", async () => {
    const started = deferred<void>();
    const releaseStart = deferred<Response>();
    const requests = installServer(
      async () => new Response("must not dispatch", { status: 200 }),
      async () => {
        started.resolve();
        return releaseStart.promise;
      },
    );
    const { result } = renderCore();
    let outcomePromise!: ReturnType<typeof append>;
    await act(async () => {
      outcomePromise = result.current.append({
        role: "user",
        content: "stop before dispatch",
      });
      await started.promise;
      result.current.stop();
      releaseStart.resolve(
        Response.json({
          workspaceId: state.fixture!.workspaceId,
          threadId: state.fixture!.threadId,
          turnId: state.fixture!.turnId,
          runAttemptId: state.fixture!.runAttemptId,
        }),
      );
    });
    let outcome!: Awaited<typeof outcomePromise>;
    await act(async () => {
      outcome = await outcomePromise;
    });

    expect(outcome).toMatchObject({
      status: "cancelled",
      admission: "not-dispatched",
    });
    expect(result.current.isLoading).toBe(false);
    expect(requests.filter(({ url }) => url.endsWith("/chat"))).toHaveLength(0);
    expect(state.interruptTurn).not.toHaveBeenCalled();
  });

  it("keeps a confirmed admission accepted when Stop follows the exact acknowledgement, then interrupts its exact tuple", async () => {
    const responseObserved = deferred<void>();
    state.onResponseObserved = () => responseObserved.resolve();
    const requests = installServer(async (_input, init) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
        },
        { highWaterMark: 0 },
      );
      init?.signal?.addEventListener(
        "abort",
        () => {
          controller?.error(
            new DOMException("aborted after acknowledgement", "AbortError"),
          );
        },
        { once: true },
      );
      return new Response(stream, { status: 200, headers: responseHeaders() });
    });
    const { result } = renderCore();
    let outcomePromise!: ReturnType<typeof append>;
    await act(async () => {
      outcomePromise = result.current.append({
        role: "user",
        content: "stop after admission ack",
      });
      await responseObserved.promise;
      // useChatCore's onResponse runs only after the observed fetch captured
      // the exact successful headers; the stalled SDK body is then aborted by Stop.
      result.current.stop();
    });
    let outcome!: Awaited<typeof outcomePromise>;
    await act(async () => {
      outcome = await outcomePromise;
    });
    const chatRequest = requests.find(({ url }) => url.endsWith("/chat"));
    const body = chatRequest?.body
      ? (JSON.parse(chatRequest.body) as Record<string, unknown>)
      : {};
    const identity = body.identity as Record<string, unknown>;

    expect(outcome).toMatchObject({
      status: "cancelled",
      admission: "accepted",
    });
    expect(state.interruptTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: state.fixture!.sessionId,
        runId: state.fixture!.runId,
        threadId: identity.threadId,
        turnId: identity.turnId,
        runAttemptId: identity.runAttemptId,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(requests.filter(({ url }) => url.endsWith("/chat"))).toHaveLength(1);
  });

  it("does not infer acceptance from a broken response body without an exact acknowledgement or canonical event", async () => {
    installServer(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(new Error("body stream broke"));
            },
          }),
          { status: 200, headers: { "X-Run-Id": state.fixture!.runId } },
        ),
    );
    const { result } = renderCore();
    const outcome = await append(result, "broken unacknowledged response");

    expect(outcome.status).toBe("unconfirmed");
  });

  it("retains known admission when a correctly bound acknowledgement body subsequently breaks", async () => {
    installServer(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(
                new Error("body stream broke after acknowledgement"),
              );
            },
          }),
          { status: 200, headers: responseHeaders() },
        ),
    );
    const { result } = renderCore();
    const outcome = await append(
      result,
      "acknowledged admission with stream failure",
    );

    expect(outcome.status).toBe("accepted");
  });
});
