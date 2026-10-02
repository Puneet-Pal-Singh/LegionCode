import { describe, expect, it } from "vitest";
import type { DurableObjectId, Fetcher } from "@cloudflare/workers-types";
import {
  enforceLaunchSafetyForRoute,
  getEmergencyShutoffMode,
} from "./LaunchSafetyService";

describe("LaunchSafetyService", () => {
  it("blocks expensive routes when emergency shutoff is active", async () => {
    const response = await enforceLaunchSafetyForRoute(
      new Request("https://secure.local/api/v1/session", {
        method: "POST",
      }),
      {
        LAUNCH_EMERGENCY_SHUTOFF_MODE: "block_session_and_execute",
      },
      "session_create",
    );

    expect(response?.status).toBe(503);
  });

  it.each(["block_session_and_execute", "block_all"] as const)(
    "blocks internal launch routes during %s maintenance",
    async (mode) => {
      const scopes: string[] = [];
      for (const routeClass of ["session_create", "execute_task"] as const) {
        const response = await enforceLaunchSafetyForRoute(
          new Request("http://internal/api/v1/execute", { method: "POST" }),
          {
            LAUNCH_EMERGENCY_SHUTOFF_MODE: mode,
            LAUNCH_RATE_LIMIT_REQUIRED: "true",
            LAUNCH_RATE_LIMITER: createMockLimiterNamespace({ scopes }),
          },
          routeClass,
        );

        expect(response?.status).toBe(503);
      }
      expect(scopes).toHaveLength(0);
    },
  );

  it.each(["block_session_and_execute", "block_all"] as const)(
    "blocks external session and execute routes during %s maintenance",
    async (mode) => {
      for (const routeClass of ["session_create", "execute_task"] as const) {
        const response = await enforceLaunchSafetyForRoute(
          new Request("https://secure.local/api/v1/execute", {
            method: "POST",
          }),
          { LAUNCH_EMERGENCY_SHUTOFF_MODE: mode },
          routeClass,
        );

        expect(response?.status).toBe(503);
        await expect(response?.json()).resolves.toMatchObject({
          code: "EMERGENCY_SHUTOFF_ACTIVE",
        });
      }
    },
  );

  it("skips launch rate limiting for internal service binding requests when open", async () => {
    const scopes: string[] = [];
    const response = await enforceLaunchSafetyForRoute(
      new Request("http://internal/api/v1/session", {
        method: "POST",
      }),
      {
        LAUNCH_EMERGENCY_SHUTOFF_MODE: "off",
        LAUNCH_RATE_LIMIT_REQUIRED: "true",
        LAUNCH_RATE_LIMITER: createMockLimiterNamespace({ scopes }),
      },
      "session_create",
    );

    expect(response).toBeNull();
    expect(scopes).toHaveLength(0);
  });

  it.each([
    [" BLOCK_ALL ", "block_all"],
    [" Block_Session_And_Execute ", "block_session_and_execute"],
    ["unknown", "off"],
  ] as const)("normalizes emergency mode %s", (input, expected) => {
    expect(
      getEmergencyShutoffMode({ LAUNCH_EMERGENCY_SHUTOFF_MODE: input }),
    ).toBe(expected);
  });

  it("returns 503 when limiter is required but unavailable", async () => {
    const response = await enforceLaunchSafetyForRoute(
      new Request("https://secure.local/api/v1/session", {
        method: "POST",
      }),
      {
        LAUNCH_RATE_LIMIT_REQUIRED: "true",
      },
      "session_create",
    );

    expect(response?.status).toBe(503);
    const payload = (await response?.json()) as { code: string };
    expect(payload.code).toBe("LAUNCH_RATE_LIMITER_UNAVAILABLE");
  });

  it("enforces per-route rate limits", async () => {
    const env = {
      LAUNCH_RATE_LIMITER: createMockLimiterNamespace(),
      SESSION_CREATE_RATE_LIMIT_AUTH_MAX: "1",
      SESSION_CREATE_RATE_LIMIT_WINDOW_SECONDS: "60",
    };

    const first = await enforceLaunchSafetyForRoute(
      new Request("https://secure.local/api/v1/session", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "CF-Connecting-IP": "203.0.113.1",
        },
      }),
      env,
      "session_create",
    );
    expect(first).toBeNull();

    const second = await enforceLaunchSafetyForRoute(
      new Request("https://secure.local/api/v1/session", {
        method: "POST",
        headers: {
          Authorization: "Bearer test",
          "CF-Connecting-IP": "203.0.113.1",
        },
      }),
      env,
      "session_create",
    );

    expect(second?.status).toBe(429);
    const payload = (await second?.json()) as { code: string };
    expect(payload.code).toBe("ROUTE_RATE_LIMITED");
  });

  it("maps limiter fetch exceptions to typed 503 response", async () => {
    const response = await enforceLaunchSafetyForRoute(
      new Request("https://secure.local/api/v1/session", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "203.0.113.7",
        },
      }),
      {
        LAUNCH_RATE_LIMITER: createMockLimiterNamespace({ throwOnFetch: true }),
      },
      "session_create",
    );

    expect(response?.status).toBe(503);
    const payload = (await response?.json()) as { code: string };
    expect(payload.code).toBe("LAUNCH_RATE_LIMITER_FAILED");
  });

  it("uses CF-Connecting-IP as the primary scope key", async () => {
    const scopes: string[] = [];
    await enforceLaunchSafetyForRoute(
      new Request("https://secure.local/api/v1/session", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "198.51.100.10",
          "X-Forwarded-For": "1.2.3.4, 5.6.7.8",
        },
      }),
      {
        LAUNCH_RATE_LIMITER: createMockLimiterNamespace({ scopes }),
      },
      "session_create",
    );

    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toContain("198.51.100.10");
    expect(scopes[0]).not.toContain("1.2.3.4");
  });
});

function createMockLimiterNamespace(options?: {
  throwOnFetch?: boolean;
  scopes?: string[];
}): DurableObjectNamespace {
  const stateByScope = new Map<string, Map<string, CounterState>>();

  return {
    idFromName(name: string) {
      options?.scopes?.push(name);
      return { toString: () => name } as DurableObjectId;
    },
    get(id: DurableObjectId) {
      const scope = id.toString();
      return {
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (options?.throwOnFetch) {
            throw new Error("limiter unavailable");
          }
          if (!init?.body || typeof init.body !== "string") {
            return new Response("Invalid payload", { status: 400 });
          }

          const payload = JSON.parse(init.body) as {
            routeClass: string;
            limit: number;
            windowSeconds: number;
          };

          const windowMs = payload.windowSeconds * 1000;
          const now = Date.now();
          const activeWindow = Math.floor(now / windowMs);
          const counters = stateByScope.get(scope) ?? new Map<string, CounterState>();
          stateByScope.set(scope, counters);
          const key = payload.routeClass;
          const current = counters.get(key);

          if (!current || current.windowBucket !== activeWindow) {
            counters.set(key, { windowBucket: activeWindow, count: 1 });
            return json({ allowed: true, retryAfterSeconds: 0 });
          }

          if (current.count >= payload.limit) {
            return json({ allowed: false, retryAfterSeconds: 1 });
          }

          counters.set(key, {
            windowBucket: current.windowBucket,
            count: current.count + 1,
          });
          return json({ allowed: true, retryAfterSeconds: 0 });
        },
      } as unknown as Fetcher;
    },
  } as unknown as DurableObjectNamespace;
}

interface CounterState {
  windowBucket: number;
  count: number;
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
