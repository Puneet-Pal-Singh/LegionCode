import {
  HookRuntimeContextSchema,
  type HookRuntimeContext,
} from "./context.js";
import {
  SessionStartRequestSchema,
  type SessionStartRequest,
} from "./requests.js";

export function createTestContext(): HookRuntimeContext {
  return HookRuntimeContextSchema.parse({
    sessionId: "thr_abcdef",
    threadId: "thr_abcdef",
    runId: "run_abcdef",
    turnId: null,
    workspaceId: "wrk_abcdef",
    workspaceRoot: "/home/sandbox/runs/run_abcdef",
    executionLocation: "cloud_sandbox",
    backendId: "cloudflare_sandbox",
    modelId: "gpt-5",
    providerId: "openai",
    permissionMode: "ask",
    capabilityManifestId: "wsm_abcdef",
    transcriptRef: null,
  });
}

export function createSessionStartRequest(): SessionStartRequest {
  return SessionStartRequestSchema.parse({
    context: createTestContext(),
    source: "new_session",
    initialWorkspaceManifestRef: null,
    capabilityManifestRef: "manifests/wsm_abcdef.json",
  });
}
