import { describe, expect, it } from "vitest";
import { createAppServerClient, createAppServerHttpTransport, type AppServerRequest } from "@legioncode/sdk";

import { AppServerController } from "./AppServerController";
import type { Env } from "../types/ai";

describe("hosted App Server integration", () => {
  it("initializes through the same SDK request envelope", async () => {
    const client = createAppServerClient({
      clientId: "hosted-test-client",
      clientVersion: "0.1.0",
      transport: {
        request: async (envelope: AppServerRequest) => {
          const response = await AppServerController.request(
            new Request("https://brain.example/app-server/request", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(envelope),
            }),
            {} as Env,
          );
          return await response.json();
        },
      },
    });

    await expect(client.initialize(["thread-management-v1"])).resolves.toMatchObject({
      environment: "hosted",
      server: { id: "legioncode-hosted" },
      unavailableCapabilities: [],
    });
  });

  it("preserves unauthorized history errors through the actual SDK HTTP transport", async () => {
    const client = createAppServerClient({
      clientId: "hosted-test-client", clientVersion: "0.1.0",
      transport: createAppServerHttpTransport({
        baseUrl: "https://brain.example", credentials: "include",
        fetchImpl: async (input, init) => AppServerController.request(new Request(input, init), {} as Env),
      }),
    });
    await expect(client.getConversationHistoryPage({ session: "550e8400-e29b-41d4-a716-446655440001" })).rejects.toMatchObject({
      code: "server_error", serverCode: "unauthorized", method: "session/history",
    });
  });

  it("cancels a streamed body as soon as it exceeds the request limit", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    const request = new Request("https://brain.example/app-server/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await AppServerController.request(request, {} as Env);
    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
  });
});
