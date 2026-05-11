// apps/brain/src/types/ai.ts
import type {
  Ai,
  DurableObjectNamespace,
  Fetcher,
  KVNamespace,
  D1Database,
  R2Bucket,
} from "@cloudflare/workers-types";

export interface Env {
  // Existing bindings
  AI: Ai;
  SECURE_API: Fetcher;

  // ✅ D1 Database for BYOK (Plan 81)
  BYOK_DB: D1Database;
  EDIT_ARTIFACTS?: R2Bucket;

  // ✅ New Keys required for Vercel AI SDK
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  AXIS_OPENROUTER_API_KEY?: string;
  AXIS_DAILY_LIMIT?: string;
  OPENAI_API_KEY?: string;
  SYSTEM_PROMPT?: string;

  // ✅ LLM Provider Configuration (Phase 3.1)
  LLM_PROVIDER?: string;
  DEFAULT_MODEL?: string;
  LITELLM_BASE_URL?: string;
  COST_UNKNOWN_PRICING_MODE?: "warn" | "block";
  COST_FAIL_ON_UNSEEDED_PRICING?: "true" | "false";
  MAX_RUN_BUDGET?: string;
  MAX_SESSION_BUDGET?: string;

  // ✅ GitHub OAuth & Session Management
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_REDIRECT_URI: string;
  GITHUB_TOKEN_ENCRYPTION_KEY: string;
  BYOK_CREDENTIAL_ENCRYPTION_KEY?: string;
  BYOK_CREDENTIAL_ENCRYPTION_KEY_VERSION?: string;
  BYOK_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS?: string;
  BYOK_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION?: string;
  BYOK_VALIDATE_LIVE_ENABLED?: "true" | "false";
  BYOK_VALIDATE_LIVE_TIMEOUT_MS?: string;
  BYOK_CONNECT_RATE_LIMIT_MAX?: string;
  BYOK_CONNECT_RATE_LIMIT_WINDOW_SECONDS?: string;
  BYOK_VALIDATE_RATE_LIMIT_MAX?: string;
  BYOK_VALIDATE_RATE_LIMIT_WINDOW_SECONDS?: string;
  SESSION_SECRET: string;
  FRONTEND_URL: string;
  CORS_ALLOWED_ORIGINS?: string;
  CORS_ALLOW_DEV_ORIGINS?: "true" | "false";
  FEATURE_FLAG_CHAT_AGENTIC_LOOP_V1?: "true" | "false" | "1" | "0";
  FEATURE_FLAG_CHAT_REVIEWER_PASS_V1?: "true" | "false" | "1" | "0";
  FEATURE_FLAG_CLOUDFLARE_AGENTS_V1?: "true" | "false" | "1" | "0";
  FEATURE_FLAG_GH_CLI_LANE_ENABLED?: "true" | "false" | "1" | "0";
  FEATURE_FLAG_GH_CLI_CI_ENABLED?: "true" | "false" | "1" | "0";
  FEATURE_FLAG_GH_CLI_PR_COMMENT_ENABLED?: "true" | "false" | "1" | "0";
  LAUNCH_EMERGENCY_SHUTOFF_MODE?: "off" | "block_runs";
  RUN_SUBMISSION_RATE_LIMIT_MAX?: string;
  RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS?: string;
  MUTATION_RUN_SUBMISSION_RATE_LIMIT_MAX?: string;
  MUTATION_RUN_SUBMISSION_RATE_LIMIT_WINDOW_SECONDS?: string;
  ACTIVE_EXPENSIVE_RUNS_PER_SESSION_MAX?: string;
  ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX?: string;
  ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX?: string;
  ACTIVE_EXPENSIVE_RUNS_ANONYMOUS_MAX?: string;
  ACTIVE_EXPENSIVE_RUN_LEASE_TTL_SECONDS?: string;

  // Service URLs (environment-driven, not hardcoded)
  MUSCLE_BASE_URL?: string;

  // KV Namespace for sessions
  SESSIONS: KVNamespace;

  // Durable Object binding for RunEngine runtime state
  RUN_ENGINE_RUNTIME: DurableObjectNamespace;
  RUN_ENGINE_AGENT?: DurableObjectNamespace;
  RUN_ADMISSION_LIMITER?: DurableObjectNamespace;

  // Session Memory Runtime for cross-run memory storage (optional)
  SESSION_MEMORY_RUNTIME?: DurableObjectNamespace;

  // Environment
  NODE_ENV?: string;
  ENVIRONMENT?: string;
}

// export interface Env {
//   AI: Ai;
//   SECURE_API: Fetcher;
// }

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: MessageRole;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // Required for role: 'tool'
  name?: string; // Optional: name of the tool
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface AgentResult {
  modelId: string;
  modelName: string;
  content: string;
  toolCalls?: ToolCall[];
}
