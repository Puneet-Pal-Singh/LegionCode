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
    expect(parsed.localTurnConfiguration).toBeUndefined();

    const localTurnConfiguration = {
      modes: ["plan", "build"],
      productModes: ["ask_always"],
      commandExecution: {
        plan: "unavailable",
        build: "single_executable_nofork",
      },
    };
    const configured = AppServerInitializeResponseSchema.parse({
      ...parsed,
      localTurnConfiguration,
    });
    expect(configured.localTurnConfiguration?.commandExecution).toEqual(
      localTurnConfiguration.commandExecution,
    );
    expect(AppServerInitializeResponseSchema.parse({
      ...parsed,
      localTurnConfiguration: {
        modes: ["plan"],
        productModes: ["ask_always"],
      },
    }).localTurnConfiguration?.commandExecution).toBeUndefined();
    for (const commandExecution of [
      { plan: "unavailable", build: "general_shell" },
      { cloud: "single_executable_nofork" },
    ]) {
      expect(AppServerInitializeResponseSchema.safeParse({
        ...parsed,
        localTurnConfiguration: { ...localTurnConfiguration, commandExecution },
      }).success).toBe(false);
    }
  });
});
