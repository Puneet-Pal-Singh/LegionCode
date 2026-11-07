import {
  ChatRequestBodySchema as PlatformChatRequestBodySchema,
  TurnScopeBootstrapSchema,
} from "@legioncode/sdk";
import { z } from "zod";

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
})
  .extend({
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
  })
  .strict();

export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;

export function parseChatRequestBody(
  input: z.input<typeof ChatRequestBodySchema>,
): ChatRequestBody {
  return ChatRequestBodySchema.parse(input);
}
