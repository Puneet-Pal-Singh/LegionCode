import { describe, expect, it } from "vitest";

import { initializeAppServer } from "./handshake.js";

describe("initializeAppServer", () => {
  it("uses one response contract for local and hosted compositions", () => {
    const request = {
      protocolVersion: "1.0.0",
      client: { id: "test", version: "0.1.0" },
      requestedCapabilities: ["workspace-selection-v1"],
    };

    const local = initializeAppServer(request, {
      environment: "local",
      serverId: "local",
      serverVersion: "0.1.0",
    });
    const hosted = initializeAppServer(request, {
      environment: "hosted",
      serverId: "hosted",
      serverVersion: "0.1.0",
    });

    expect(local.statusCode).toBe(200);
    expect(hosted.statusCode).toBe(200);
    if (local.statusCode === 200 && hosted.statusCode === 200) {
      expect(local.payload.environment).toBe("local");
      expect(local.payload.unavailableCapabilities.length).toBeGreaterThan(0);
      expect(hosted.payload.environment).toBe("hosted");
      expect(hosted.payload.unavailableCapabilities).toEqual([]);
    }
  });
});
