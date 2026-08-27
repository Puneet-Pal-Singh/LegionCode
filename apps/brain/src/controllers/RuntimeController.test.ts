import { describe, expect, it, vi } from "vitest";
import { RuntimeController } from "./RuntimeController";
import type { Env } from "../types/ai";

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("RuntimeController", () => {
  it("returns worker runtime metadata with debug headers", async () => {
    const env = createEnv(createRuntimeNamespace());

    const response = await RuntimeController.getRuntimeDebug(
      new Request("https://brain.local/api/debug/runtime"),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-LegionCode-Runtime-Name")).toBe(
      "brain-worker",
    );

    const body = (await response.json()) as {
      worker: {
        bindings: {
          secureApiBound: boolean;
          runEngineRuntimeBound: boolean;
        };
      };
    };
    expect(body.worker.bindings.secureApiBound).toBe(true);
    expect(body.worker.bindings.runEngineRuntimeBound).toBe(true);
  });

  it("includes run-engine runtime metadata when runId is provided", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          runtime: {
            name: "brain-run-engine-do",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const env = createEnv(createRuntimeNamespace(fetch));

    const response = await RuntimeController.getRuntimeDebug(
      new Request(
        `https://brain.local/api/debug/runtime?runId=${encodeURIComponent(RUN_ID)}`,
      ),
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runEngineRuntime: {
        available: boolean;
        runtime: { name: string };
      };
    };
    expect(body.runEngineRuntime.available).toBe(true);
    expect(body.runEngineRuntime.runtime.name).toBe("brain-run-engine-do");
    expect(fetch).toHaveBeenCalledWith("https://run-engine/debug/runtime", {
      method: "GET",
    });
  });
});

function createRuntimeNamespace(fetchImpl?: ReturnType<typeof vi.fn>) {
  const fetch =
    fetchImpl ??
    vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

  return {
    idFromName: vi.fn(() => ({ toString: () => "mock-do-id" })),
    get: vi.fn(() => ({ fetch })),
  } as unknown as Env["RUN_ENGINE_RUNTIME"];
}

function createEnv(runEngineRuntime: Env["RUN_ENGINE_RUNTIME"]): Env {
  return {
    AI: {} as Env["AI"],
    SECURE_API: {
      fetch: vi.fn(async () => new Response(JSON.stringify({ success: true }))),
    } as unknown as Env["SECURE_API"],
    GITHUB_CLIENT_ID: "x",
    GITHUB_CLIENT_SECRET: "x",
    GITHUB_REDIRECT_URI: "x",
    GITHUB_TOKEN_ENCRYPTION_KEY: "x",
    SESSION_SECRET: "x",
    FRONTEND_URL: "http://localhost:5173",
    MUSCLE_BASE_URL: "http://localhost:8787",
    RUNTIME_GIT_SHA: "test-sha",
    SESSIONS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as Env["SESSIONS"],
    RUN_ENGINE_RUNTIME: runEngineRuntime,
  };
}
