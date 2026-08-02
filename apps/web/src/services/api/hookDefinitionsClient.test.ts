import { describe, expect, it, vi } from "vitest";
import {
  createHookDefinitionsClient,
  type HookDefinition,
} from "./hookDefinitionsClient.js";

const definition: HookDefinition = {
  handlerId: "personal.session-start",
  eventName: "SessionStart",
  source: "user",
  displayName: "Personal startup check",
  enabled: true,
  order: 10,
  timeoutMs: 500,
  configurationKey: "hooks.personal.startup",
};

const brainBaseUrl = `${window.location.origin}/__legioncode/brain`;

describe("HookDefinitionsClient", () => {
  it("reads authenticated workspace definitions through the narrow API facade", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ hooks: [definition] }), { status: 200 }),
    );
    const client = createHookDefinitionsClient(fetchImpl);

    await expect(client.list("workspace_1")).resolves.toEqual([definition]);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${brainBaseUrl}/api/workspaces/workspace_1/hooks`,
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("writes only user-managed definitions and preserves the complete typed definition", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ hook: { ...definition, enabled: false } }), {
        status: 200,
      }),
    );
    const client = createHookDefinitionsClient(fetchImpl);

    await expect(
      client.update("workspace_1", { ...definition, enabled: false }),
    ).resolves.toMatchObject({ enabled: false });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${brainBaseUrl}/api/workspaces/workspace_1/hooks/personal.session-start`,
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({ ...definition, enabled: false }),
      }),
    );

    await expect(
      client.update("workspace_1", { ...definition, source: "project" }),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("deletes an explicit user definition through the server route", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createHookDefinitionsClient(fetchImpl);

    await expect(
      client.delete("workspace_1", definition.handlerId),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(
      `${brainBaseUrl}/api/workspaces/workspace_1/hooks/personal.session-start`,
      expect.objectContaining({ method: "DELETE", credentials: "include" }),
    );
  });
});
