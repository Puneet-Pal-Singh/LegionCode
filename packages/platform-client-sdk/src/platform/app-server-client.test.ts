import { describe, expect, it } from "vitest";

import {
  AppServerHandshakeError,
  createAppServerClient,
} from "./app-server-client.js";

describe("AppServerClient", () => {
  it("sends a typed initialize request and returns explicit unavailable capabilities", async () => {
    let request: Request | undefined;
    const client = createAppServerClient({
      baseUrl: "http://127.0.0.1:4321/",
      clientId: "desktop",
      clientVersion: "0.1.0",
      credential: "ephemeral-secret",
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return new Response(
          JSON.stringify({
            protocolVersion: "1.0.0",
            server: { id: "local", version: "0.1.0" },
            environment: "local",
            capabilities: [],
            unavailableCapabilities: [
              {
                capability: "workspace-selection-v1",
                reason: "Planned for a later local slice",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await client.initialize(["workspace-selection-v1"]);

    expect(request?.url).toBe("http://127.0.0.1:4321/initialize");
    expect(request?.headers.get("authorization")).toBe(
      "Bearer ephemeral-secret",
    );
    expect(response.capabilities).toEqual([]);
    expect(response.unavailableCapabilities[0]?.capability).toBe(
      "workspace-selection-v1",
    );
  });

  it("surfaces an incompatible host without silently falling back", async () => {
    const client = createAppServerClient({
      baseUrl: "http://127.0.0.1:4321",
      clientId: "desktop",
      clientVersion: "0.1.0",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            code: "protocol_incompatible",
            message: "Unsupported protocol version",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    });

    await expect(client.initialize()).rejects.toMatchObject({
      name: "AppServerHandshakeError",
      code: "protocol_incompatible",
      statusCode: 409,
    } satisfies Partial<AppServerHandshakeError>);
  });
});
