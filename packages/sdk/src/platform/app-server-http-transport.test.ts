import { describe, expect, it, vi } from "vitest";

import { APP_SERVER_PROTOCOL_VERSION } from "@legioncode/app-server/protocol";
import { createAppServerHttpTransport } from "./app-server-http-transport.js";

const envelope = {
  protocolVersion: APP_SERVER_PROTOCOL_VERSION,
  method: "workspace/current",
  params: {},
} as const;

describe("App Server HTTP transport", () => {
  it("posts only the protocol envelope to the single request endpoint", async () => {
    let call: { url: string; init: RequestInit } | undefined;
    const transport = createAppServerHttpTransport({
      baseUrl: "http://127.0.0.1:4310/",
      credential: "per-launch-secret",
      fetchImpl: async (input, init) => {
        call = { url: String(input), init: init ?? {} };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await transport.request(envelope);

    expect(call?.url).toBe("http://127.0.0.1:4310/app-server/request");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("error");
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer per-launch-secret");
    expect(call?.init.body).toBe(JSON.stringify(envelope));
  });

  it("adds per-request private headers without allowing them to replace transport security headers", async () => {
    let call: { init: RequestInit } | undefined;
    const transport = createAppServerHttpTransport({
      baseUrl: "http://127.0.0.1:4310",
      credential: "fixed-bearer",
      requestHeaders: async () => ({
        "x-legioncode-provider-configuration": '{"providerId":"openai","status":"present"}',
        aUtHoRiZaTiOn: "attacker-bearer",
        ACCEPT: "text/plain",
        "content-type": "text/plain",
      }),
      fetchImpl: async (_input, init) => {
        call = { init: init ?? {} };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    await transport.request(envelope);

    const headers = new Headers(call?.init.headers);
    expect(headers.get("x-legioncode-provider-configuration")).toBe('{"providerId":"openai","status":"present"}');
    expect(headers.get("authorization")).toBe("Bearer fixed-bearer");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("rejects redirect responses without making a follow-up request", async () => {
    let callCount = 0;
    const transport = createAppServerHttpTransport({
      baseUrl: "http://127.0.0.1:4310",
      credential: "secret",
      fetchImpl: async (_input, init) => {
        callCount += 1;
        expect(init?.redirect).toBe("error");
        return new Response(null, { status: 302, headers: { location: "https://attacker.invalid/" } });
      },
    });
    await expect(transport.request(envelope)).rejects.toMatchObject({ code: "transport" });
    expect(callCount).toBe(1);
  });

  it("rejects oversized streamed bodies even without a content-length header", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
        controller.close();
      },
    });
    const transport = createAppServerHttpTransport({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl: async () => new Response(body, { status: 200 }),
    });

    await expect(transport.request(envelope)).rejects.toMatchObject({
      code: "transport",
      message: "App Server response is too large",
    });
  });

  it("retains the default declared size limit unless the operation explicitly disables it", async () => {
    const payload = { content: "x".repeat(1_048_577) };
    const serialized = JSON.stringify(payload);
    const fetchImpl = async () => new Response(serialized, {
      headers: { "content-length": String(serialized.length) },
    });
    const options = { baseUrl: "https://brain.example", fetchImpl };
    await expect(createAppServerHttpTransport(options).request(envelope)).rejects.toMatchObject({
      code: "transport", message: "App Server response is too large",
    });
    await expect(createAppServerHttpTransport({ ...options, maxResponseBytes: null }).request(envelope)).resolves.toEqual(payload);
  });

  it("times out while waiting for the response body", async () => {
    const transport = createAppServerHttpTransport({
      baseUrl: "http://127.0.0.1:4310",
      timeoutMs: 5,
      fetchImpl: async (_input, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(body, { status: 200 });
      },
    });

    await expect(transport.request(envelope)).rejects.toMatchObject({ code: "timeout" });
  });

  it("preserves correlated canonical errors from non-2xx responses", async () => {
    const transport = createAppServerHttpTransport({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "workspace/current",
            ok: false,
            error: { code: "invalid_request", message: "workspace unavailable" },
          }),
          { status: 409 },
        ),
    });
    await expect(transport.request(envelope)).resolves.toMatchObject({
      method: "workspace/current",
      ok: false,
      error: { code: "invalid_request" },
    });
  });

  it("rejects non-2xx failure envelopes for another method", async () => {
    const transport = createAppServerHttpTransport({
      baseUrl: "http://127.0.0.1:4310",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            protocolVersion: APP_SERVER_PROTOCOL_VERSION,
            method: "thread/list",
            ok: false,
            error: { code: "invalid_request", message: "wrong method" },
          }),
          { status: 400 },
        ),
    });
    await expect(transport.request(envelope)).rejects.toMatchObject({ code: "transport" });
  });
});

describe("hosted history transport lifetime", () => {
  it("keeps cookie-scoped reads cancellable without introducing a five-second history deadline", async () => {
    vi.useFakeTimers();
    try {
      let resolveResponse!: (response: Response) => void;
      let request: RequestInit | undefined;
      const controller = new AbortController();
      const transport = createAppServerHttpTransport({
        baseUrl: "https://brain.example", credentials: "include", timeoutMs: null,
        signal: controller.signal,
        fetchImpl: async (_input, init) => {
          request = init;
          return new Promise<Response>((resolve) => { resolveResponse = resolve; });
        },
      });
      const result = transport.request(envelope);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(request?.credentials).toBe("include");
      expect(request?.signal?.aborted).toBe(false);
      controller.abort();
      expect(request?.signal?.aborted).toBe(true);
      resolveResponse(new Response(JSON.stringify({ ok: true })));
      await result;
    } finally { vi.useRealTimers(); }
  });
});
