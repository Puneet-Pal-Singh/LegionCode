import type { ProductMode, RunMode } from "@repo/shared-types";
import { z } from "zod";

export const RuntimeHarnessIdSchema = z.enum([
  "cloudflare-sandbox",
  "local-sandbox",
]);

export const ChatRequestBodySchema = z
  .object({
    sessionId: z.string().trim().min(1),
    runId: z.string().trim().min(1),
    clientMessageId: z.string().trim().min(1).optional(),
    mode: z.custom<RunMode>().optional(),
    productMode: z.custom<ProductMode>().optional(),
    providerId: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).optional(),
    harnessId: RuntimeHarnessIdSchema.optional(),
    repositoryOwner: z.string().trim().min(1).optional(),
    repositoryName: z.string().trim().min(1).optional(),
    repositoryBranch: z.string().trim().min(1).optional(),
    repositoryBaseUrl: z.string().url().optional(),
  })
  .strict();

export type RuntimeHarnessId = z.infer<typeof RuntimeHarnessIdSchema>;
export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

const DEFAULT_RUNTIME_HARNESS: RuntimeHarnessId = "cloudflare-sandbox";
const RUNTIME_HARNESS_QUERY_PARAM = "harness";
const RUNTIME_HARNESS_SESSION_KEY_PREFIX = "shadowbox:runtime-harness:";

export function parseChatRequestBody(input: ChatRequestBody): ChatRequestBody {
  return ChatRequestBodySchema.parse(input);
}

export function resolveRuntimeHarnessId(sessionId: string): RuntimeHarnessId {
  return (
    loadRuntimeHarnessFromSession(sessionId) ??
    loadRuntimeHarnessFromQuery() ??
    DEFAULT_RUNTIME_HARNESS
  );
}

function loadRuntimeHarnessFromSession(
  sessionId: string,
): RuntimeHarnessId | undefined {
  try {
    const storedHarness = sessionStorage.getItem(
      `${RUNTIME_HARNESS_SESSION_KEY_PREFIX}${sessionId}`,
    );
    return parseRuntimeHarnessId(storedHarness);
  } catch {
    return undefined;
  }
}

function loadRuntimeHarnessFromQuery(): RuntimeHarnessId | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const queryHarness = new URLSearchParams(window.location.search).get(
    RUNTIME_HARNESS_QUERY_PARAM,
  );
  return parseRuntimeHarnessId(queryHarness);
}

function parseRuntimeHarnessId(value: unknown): RuntimeHarnessId | undefined {
  const parsed = RuntimeHarnessIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
