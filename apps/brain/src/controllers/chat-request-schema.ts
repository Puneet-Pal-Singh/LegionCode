import {
  ProductModeSchema,
  RunModeSchema,
  WorkflowEntrypointSchema,
  WorkflowIntentSchema,
} from "@repo/shared-types";
import { z } from "zod";

const SerializableToolDefinitionSchema = z.object({
  description: z.string().optional(),
  inputSchema: z.object({}).catchall(z.unknown()).optional(),
  parameters: z.object({}).catchall(z.unknown()).optional(),
});

export const ChatRequestBodySchema = z.object({
  messages: z.array(z.unknown()).optional(),
  clientMessageId: z.string().trim().min(1).optional(),
  tools: z.record(SerializableToolDefinitionSchema).optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  mode: RunModeSchema.optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  harnessId: z.enum(["cloudflare-sandbox", "local-sandbox"]).optional(),
  orchestratorBackend: z
    .enum(["execution-engine-v1", "cloudflare_agents"])
    .optional(),
  executionBackend: z
    .enum(["cloudflare_sandbox", "e2b", "daytona"])
    .optional(),
  harnessMode: z.enum(["platform_owned", "delegated"]).optional(),
  authMode: z.enum(["api_key", "oauth"]).optional(),
  productMode: ProductModeSchema.optional(),
  workflowIntent: WorkflowIntentSchema.optional(),
  workflowEntrypoint: WorkflowEntrypointSchema.optional(),
  repositoryOwner: z.string().optional(),
  repositoryName: z.string().optional(),
  repositoryBranch: z.string().optional(),
  repositoryBaseUrl: z.string().optional(),
});

export type ChatRequestBody = z.infer<typeof ChatRequestBodySchema>;
