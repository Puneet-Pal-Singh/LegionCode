import { handleAppServerHttpRequest } from "@legioncode/app-server/server";

import { getCorsHeaders } from "../lib/cors";
import type { Env } from "../types/ai";

const MAX_REQUEST_BYTES = 32 * 1024;

export const AppServerController = {
  async request(request: Request, env: Env): Promise<Response> {
    const body = await readBoundedBody(request);
    if (body.oversized) {
      return json(env, request, 413, {
        code: "invalid_request",
        message: "App Server request is too large",
      });
    }
    const result = await handleAppServerHttpRequest(
      {
        method: request.method,
        path: new URL(request.url).pathname,
        origin: request.headers.get("origin") ?? undefined,
        contentType: request.headers.get("content-type") ?? undefined,
        rawBody: body.value,
      },
      {
        environment: "hosted",
        serverId: "legioncode-hosted",
        serverVersion: "0.1.0",
      },
    );
    return json(env, request, result.statusCode, result.payload);
  },
};

async function readBoundedBody(
  request: Request,
): Promise<{ value: string; oversized: boolean }> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    await request.body?.cancel();
    return { value: "", oversized: true };
  }
  if (!request.body) return { value: "", oversized: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return { value: "", oversized: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: new TextDecoder("utf-8", { fatal: true }).decode(bytes), oversized: false };
  } catch {
    return { value: "\u0000", oversized: false };
  }
}

function json(
  env: Env,
  request: Request,
  status: number,
  payload: unknown,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      "Content-Type": "application/json",
    },
  });
}
