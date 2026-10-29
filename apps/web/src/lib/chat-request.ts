import { ChatRequestBodySchema as PlatformChatRequestBodySchema, TurnScopeBootstrapSchema } from "@repo/platform-protocol";
import { z } from "zod";

export const RuntimeHarnessIdSchema = z.enum([
  "cloudflare-sandbox",
  "local-sandbox",
]);

// The composer builder keeps its established required identity and URL checks,
// while deriving the allowed field set from the shared wire contract.
export const ChatRequestBodySchema = PlatformChatRequestBodySchema.omit({
  id: true,
  messages: true,
  tools: true,
  agentId: true,
  orchestratorBackend: true,
  executionBackend: true,
  harnessMode: true,
  authMode: true,
  workflowIntent: true,
  workflowEntrypoint: true,
}).extend({
  sessionId: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  identity: TurnScopeBootstrapSchema,
  clientMessageId: z.string().trim().min(1).optional(),
  providerId: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
  repositoryOwner: z.string().trim().min(1).optional(),
  repositoryName: z.string().trim().min(1).optional(),
  repositoryBranch: z.string().trim().min(1).optional(),
  repositoryBaseUrl: z.string().url().optional(),
}).strict();

export type RuntimeHarnessId = z.infer<typeof RuntimeHarnessIdSchema>;
export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

const DEFAULT_RUNTIME_HARNESS: RuntimeHarnessId = "cloudflare-sandbox";
const RUNTIME_HARNESS_QUERY_PARAM = "harness";
const RUNTIME_HARNESS_SESSION_KEY_PREFIX = "legioncode:runtime-harness:";

export function parseChatRequestBody(
  input: z.input<typeof ChatRequestBodySchema>,
): ChatRequestBody {
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
