import { initializeAppServer } from "@legioncode/app-server";

import { getCorsHeaders } from "../lib/cors";
import type { Env } from "../types/ai";

export const AppServerController = {
  async initialize(request: Request, env: Env): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(env, request, 400, {
        code: "invalid_request",
        message: "App Server initialize request is invalid",
      });
    }

    const result = initializeAppServer(body, {
      environment: "hosted",
      serverId: "legioncode-hosted",
      serverVersion: "0.1.0",
    });
    return json(env, request, result.statusCode, result.payload);
  },
};

function json(
  env: Env,
  request: Request,
  status: number,
  payload: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      "Content-Type": "application/json",
    },
  });
}
