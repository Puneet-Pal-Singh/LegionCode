import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types/ai";

const helpers = vi.hoisted(() => ({
  getAuthenticatedUserSession: vi.fn(),
  isSessionStoreUnavailableError: vi.fn(() => false),
  withWorkspaceRepository: vi.fn(),
  withHookDefinitionRepository: vi.fn(),
  list: vi.fn(),
  upsert: vi.fn(),
  deleteUserDefinition: vi.fn(),
}));

vi.mock("../services/AuthService", () => ({
  getAuthenticatedUserSession: helpers.getAuthenticatedUserSession,
  isSessionStoreUnavailableError: helpers.isSessionStoreUnavailableError,
}));

vi.mock("../services/workspaces/WorkspacePersistenceFactory", () => ({
  withWorkspaceRepository: helpers.withWorkspaceRepository,
}));

vi.mock("../services/hooks/HookDefinitionPersistenceFactory", () => ({
  withHookDefinitionRepository: helpers.withHookDefinitionRepository,
}));

import { HookDefinitionController } from "./HookDefinitionController";

const WORKSPACE_ID = "10db59dc-7c02-4b04-86ee-d6b584d2d1b3";
const DEFINITION = {
  handlerId: "user.prompt-check",
  eventName: "UserPromptSubmit",
  source: "user",
  displayName: "Prompt check",
  enabled: true,
  order: 20,
  timeoutMs: 1_000,
  configurationKey: "hooks/prompt-check",
};

describe("HookDefinitionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    helpers.getAuthenticatedUserSession.mockResolvedValue({
      userId: "user-1",
      session: {},
    });
    helpers.withWorkspaceRepository.mockImplementation((_env, callback) =>
      callback({
        listWorkspaces: vi.fn().mockResolvedValue([
          {
            workspace: { id: WORKSPACE_ID },
          },
        ]),
      }),
    );
    helpers.withHookDefinitionRepository.mockImplementation((_env, callback) =>
      callback({
        list: helpers.list,
        upsert: helpers.upsert,
        deleteUserDefinition: helpers.deleteUserDefinition,
      }),
    );
  });

  it("denies unauthenticated reads before opening repositories", async () => {
    helpers.getAuthenticatedUserSession.mockResolvedValueOnce(null);

    const response = await HookDefinitionController.list(
      requestFor("", "GET"),
      {} as Env,
    );

    expect(response.status).toBe(401);
    expect(helpers.withWorkspaceRepository).not.toHaveBeenCalled();
    expect(helpers.withHookDefinitionRepository).not.toHaveBeenCalled();
  });

  it("does not expose hook configuration across workspace ownership", async () => {
    helpers.withWorkspaceRepository.mockImplementationOnce((_env, callback) =>
      callback({ listWorkspaces: vi.fn().mockResolvedValue([]) }),
    );

    const response = await HookDefinitionController.list(
      requestFor("", "GET"),
      {} as Env,
    );

    expect(response.status).toBe(404);
    expect(helpers.withHookDefinitionRepository).not.toHaveBeenCalled();
  });

  it("persists a validated user definition in the authenticated scope", async () => {
    helpers.upsert.mockImplementation(async (scope, definition, now) => ({
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      definition,
      createdAt: now,
      updatedAt: now,
    }));

    const response = await HookDefinitionController.upsert(
      requestFor(`/${DEFINITION.handlerId}`, "PUT", DEFINITION),
      {} as Env,
    );

    expect(response.status).toBe(200);
    expect(helpers.upsert).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: WORKSPACE_ID },
      DEFINITION,
      expect.any(String),
    );
    await expect(response.json()).resolves.toMatchObject({
      hook: { definition: DEFINITION },
    });
  });

  it("rejects provenance spoofing and handler identity mismatches", async () => {
    const projectResponse = await HookDefinitionController.upsert(
      requestFor(`/${DEFINITION.handlerId}`, "PUT", {
        ...DEFINITION,
        source: "project",
      }),
      {} as Env,
    );
    const mismatchResponse = await HookDefinitionController.upsert(
      requestFor("/user.other-hook", "PUT", DEFINITION),
      {} as Env,
    );

    expect(projectResponse.status).toBe(403);
    expect(mismatchResponse.status).toBe(400);
    expect(helpers.upsert).not.toHaveBeenCalled();
  });

  it("deletes only through the user-definition repository boundary", async () => {
    helpers.deleteUserDefinition.mockResolvedValue(true);

    const response = await HookDefinitionController.delete(
      requestFor(`/${DEFINITION.handlerId}`, "DELETE"),
      {} as Env,
    );

    expect(response.status).toBe(204);
    expect(helpers.deleteUserDefinition).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: WORKSPACE_ID },
      DEFINITION.handlerId,
    );
  });
});

function requestFor(
  suffix: string,
  method: string,
  body?: unknown,
): Request {
  return new Request(
    `https://brain.local/api/workspaces/${WORKSPACE_ID}/hooks${suffix}`,
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
    },
  );
}
