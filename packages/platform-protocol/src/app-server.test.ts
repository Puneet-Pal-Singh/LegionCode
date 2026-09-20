import { describe, expect, it } from "vitest";

import {
  AppServerInitializeRequestSchema,
  AppServerInitializeResponseSchema,
} from "./app-server.js";

describe("App Server handshake contract", () => {
  it("requires an explicit client identity and capability request", () => {
    expect(
      AppServerInitializeRequestSchema.safeParse({
        protocolVersion: "1.0.0",
        client: { id: "desktop", version: "0.1.0" },
        requestedCapabilities: ["workspace-selection-v1"],
      }).success,
    ).toBe(true);
    expect(
      AppServerInitializeRequestSchema.safeParse({ protocolVersion: "1.0.0" })
        .success,
    ).toBe(false);
  });

  it("keeps unavailable local capabilities explicit", () => {
    const parsed = AppServerInitializeResponseSchema.parse({
      protocolVersion: "1.0.0",
      server: { id: "legioncode-local", version: "0.1.0" },
      environment: "local",
      capabilities: [],
      unavailableCapabilities: [
        {
          capability: "workspace-selection-v1",
          reason: "Planned for a later local slice",
        },
      ],
    });

    expect(parsed.capabilities).toEqual([]);
    expect(parsed.unavailableCapabilities).toHaveLength(1);
  });
});
