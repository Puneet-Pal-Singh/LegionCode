import { describe, expect, it } from "vitest";

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
