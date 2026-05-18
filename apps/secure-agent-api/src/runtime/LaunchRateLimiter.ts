import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const EnforceRequestSchema = z.object({
  routeClass: z.enum(["session_create", "execute_task"]),
  limit: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
});

type EnforceRequest = z.infer<typeof EnforceRequestSchema>;

interface EnforceResponse {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface WindowCounterState {
  windowBucket: number;
  count: number;
}

const COUNTER_KEY_PREFIX = "launch:secure-api:rate-limit:v1:";

// RECONSTRUCTABILITY: Launch limiter counters are runtime throttling hints only.
// Losing this DO state can briefly reset launch throttles, but cannot delete or
// corrupt canonical product data stored in Postgres/R2.
export class LaunchRateLimiter extends DurableObject {
  private requestQueue: Promise<void> = Promise.resolve();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/enforce") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    return this.withRequestLock(async () => {
      try {
        const payload = EnforceRequestSchema.parse(await request.json());
        const result = await this.enforce(payload);
        return jsonResponse(result, 200);
      } catch (error: unknown) {
        if (error instanceof z.ZodError || error instanceof SyntaxError) {
          return jsonResponse({ error: "Invalid launch limiter payload" }, 400);
        }

        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[launch/rate-limiter] Failed to enforce limit:", message);
        return jsonResponse({ error: "Failed to enforce launch rate limit" }, 500);
      }
    });
  }

  private async enforce(payload: EnforceRequest): Promise<EnforceResponse> {
    const now = Date.now();
    const windowMs = payload.windowSeconds * 1000;
    const activeWindow = Math.floor(now / windowMs);
    const key = this.buildCounterKey(payload.routeClass);
    const current = await this.readCounter(key);

    if (!current || current.windowBucket !== activeWindow) {
      await this.writeCounter(key, {
        windowBucket: activeWindow,
        count: 1,
      });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= payload.limit) {
      return {
        allowed: false,
        retryAfterSeconds: this.computeRetryAfterSeconds(activeWindow, windowMs, now),
      };
    }

    await this.writeCounter(key, {
      windowBucket: current.windowBucket,
      count: current.count + 1,
    });

    return { allowed: true, retryAfterSeconds: 0 };
  }

  private async readCounter(key: string): Promise<WindowCounterState | null> {
    const raw = await this.ctx.storage.get<string>(key);
    if (typeof raw !== "string") {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as WindowCounterState;
      if (
        !Number.isInteger(parsed.windowBucket) ||
        !Number.isInteger(parsed.count) ||
        parsed.windowBucket < 0 ||
        parsed.count < 0
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeCounter(
    key: string,
    state: WindowCounterState,
  ): Promise<void> {
    await this.ctx.storage.put(key, JSON.stringify(state));
  }

  private buildCounterKey(routeClass: EnforceRequest["routeClass"]): string {
    return `${COUNTER_KEY_PREFIX}${routeClass}`;
  }

  private computeRetryAfterSeconds(
    windowBucket: number,
    windowMs: number,
    now: number,
  ): number {
    const windowEnd = (windowBucket + 1) * windowMs;
    const remainingMs = Math.max(windowEnd - now, 1000);
    return Math.ceil(remainingMs / 1000);
  }

  private async withRequestLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.requestQueue;
    let release: () => void = () => {};
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
