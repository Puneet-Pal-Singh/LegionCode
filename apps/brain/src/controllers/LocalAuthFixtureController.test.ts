import { describe, expect, it } from "vitest";
import {
  MemoryIdentitySessionRepository,
  MemoryWorkspaceRepository,
} from "@repo/persistence";
import { AuthController } from "./AuthController";
import { LocalAuthFixtureController } from "./LocalAuthFixtureController";
import { WorkspaceController } from "./WorkspaceController";
import type { Env } from "../types/ai";

describe("LocalAuthFixtureController", () => {
  it("stays unavailable unless the explicit loopback fixture contract is enabled", async () => {
    const env = createEnv();

    const disabled = await LocalAuthFixtureController.handleCreateSession(
      fixtureRequest(),
      env,
    );
    const missingHeader = await LocalAuthFixtureController.handleCreateSession(
      new Request("http://127.0.0.1:8788/auth/local-test/session", {
        method: "POST",
      }),
      { ...env, SHADOWBOX_LOCAL_AUTH_FIXTURE: "1" },
    );
    const remote = await LocalAuthFixtureController.handleCreateSession(
      new Request("https://example.test/auth/local-test/session", {
        method: "POST",
        headers: { "X-Shadowbox-Local-Auth": "1" },
      }),
      { ...env, SHADOWBOX_LOCAL_AUTH_FIXTURE: "1" },
    );

    expect(disabled.status).toBe(404);
    expect(missingHeader.status).toBe(404);
    expect(remote.status).toBe(404);
  });

  it("creates a normal session and minimal Shadowbox workspace through repositories", async () => {
    const env = createEnv({ SHADOWBOX_LOCAL_AUTH_FIXTURE: "1" });
    const response = await LocalAuthFixtureController.handleCreateSession(
      fixtureRequest(),
      env,
    );
    const cookie = response.headers.get("Set-Cookie");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      fixture: "local",
      workspaceName: "Shadowbox",
    });
    expect(cookie).toMatch(/^shadowbox_session=[^;]+;/);
    expect(cookie).toContain("HttpOnly");

    const sessionResponse = await AuthController.handleGetSession(
      new Request("http://127.0.0.1:8788/auth/session", {
        headers: { Cookie: cookie?.split(";")[0] ?? "" },
      }),
      env,
    );
    const workspaceResponse = await WorkspaceController.listWorkspaces(
      new Request("http://127.0.0.1:8788/api/workspaces", {
        headers: { Cookie: cookie?.split(";")[0] ?? "" },
      }),
      env,
    );

    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      authenticated: true,
      user: { login: "shadowbox-local-test" },
    });
    expect(workspaceResponse.status).toBe(200);
    await expect(workspaceResponse.json()).resolves.toMatchObject({
      workspaces: [{ workspace: { name: "Shadowbox" }, selected: true }],
    });
  });

  it("returns a typed unavailable response when local encryption configuration is absent", async () => {
    const response = await LocalAuthFixtureController.handleCreateSession(
      fixtureRequest(),
      createEnv({
        SHADOWBOX_LOCAL_AUTH_FIXTURE: "1",
        GITHUB_TOKEN_ENCRYPTION_KEY: "",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Local auth fixture unavailable",
      code: "LOCAL_AUTH_FIXTURE_UNAVAILABLE",
    });
  });
});

function fixtureRequest(): Request {
  return new Request("http://127.0.0.1:8788/auth/local-test/session", {
    method: "POST",
    headers: { "X-Shadowbox-Local-Auth": "1" },
  });
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_IDENTITY_REPOSITORY: new MemoryIdentitySessionRepository(),
    AUTH_WORKSPACE_REPOSITORY: new MemoryWorkspaceRepository(),
    GITHUB_CLIENT_ID: "local-fixture-client",
    GITHUB_CLIENT_SECRET: "local-fixture-secret",
    GITHUB_REDIRECT_URI: "http://127.0.0.1:8788/auth/github/callback",
    GITHUB_TOKEN_ENCRYPTION_KEY: "local-fixture-encryption-key",
    SESSION_SECRET: "local-fixture-session-secret",
    FRONTEND_URL: "http://127.0.0.1:5174/agents/",
    ...overrides,
  } as Env;
}
