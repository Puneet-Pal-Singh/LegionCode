import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatCore } from "./useChatCore";

const { followTurnLifecycle } = vi.hoisted(() => ({
  followTurnLifecycle: vi.fn(async function* () {}),
}));

vi.mock("./useProviderStore.js", () => ({
  useProviderStore: () => ({
    status: "ready",
    credentials: [{ id: "credential_fixture" }],
    selectedProviderId: "openai",
    selectedCredentialId: "credential_fixture",
    selectedModelId: "gpt-fixture",
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
    interruptTurn: vi.fn(),
    startTurn: vi.fn(),
  }),
}));

vi.mock("./useActiveTurnProjection.js", () => ({
  useActiveTurnProjection: ({ turnId }: { turnId: string | null }) => ({
    turnId,
    projection: null,
    hasCanonicalTurn: Boolean(turnId),
    hasReplay: false,
    isActive: false,
    isTerminal: false,
    isTransportPending: false,
  }),
  deriveCanonicalRunLoading: (_projection: unknown, transportPending: boolean) =>
    transportPending,
  resolveActiveProjectionTurnId: () => null,
}));

describe("useChatCore installed SDK transport behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    followTurnLifecycle.mockClear();
  });

  it("does not report a 503 as a successful submission when the SDK resolves append", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({ url, method });
        if (url.includes("/turn/scope?")) {
          return new Response("scope unavailable", { status: 404 });
        }
        if (url.endsWith("/turn/start")) {
          return Response.json({
            workspaceId: "d1137b54-39df-4f38-b012-478018630ace",
            threadId: "thr_transport_fixture01",
            turnId: "trn_transport_fixture01",
            runAttemptId: "attempt_transport_fixture01",
          });
        }
        if (url.endsWith("/chat")) {
          return new Response("upstream unavailable", { status: 503 });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    const { result } = renderHook(() =>
      useChatCore(
        "d1137b54-39df-4f38-b012-478018630ace",
        "run_transport_fixture01",
      ),
    );

    act(() => {
      result.current.handleInputChange({ target: { value: "Keep this intent" } } as never);
    });
    let submitted!: boolean;
    await act(async () => {
      submitted = await result.current.handleSubmit();
    });

    expect(requests.some(({ url, method }) => url.endsWith("/turn/start") && method === "POST")).toBe(true);
    expect(requests.some(({ url, method }) => url.endsWith("/chat") && method === "POST")).toBe(true);
    expect.soft(submitted).toBe(false);
    expect.soft(result.current.error).toBeTruthy();
    expect.soft(result.current.input).toBe("Keep this intent");
  });
});
