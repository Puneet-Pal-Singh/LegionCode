import { z } from "zod";
import type { Env } from "../../types/ai";

interface SecureMuscleSession {
  sessionId: string;
  token: string;
}

interface PluginSuccessPayload {
  success: true;
  output?: unknown;
}

interface PluginErrorPayload {
  success: false;
  error?: string;
}

interface CanonicalExecutionResponse {
  taskId: string;
  status: "success" | "failure" | "timeout" | "cancelled";
  output?: string;
  error?: {
    message?: string;
  };
}

const PatchCapturePayloadSchema = z.object({
  patch: z.string(),
  baseCommitSha: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
});
const GitStatusPayloadSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      status: z.string().min(1),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      isStaged: z.boolean(),
    }),
  ),
  ahead: z.number().int(),
  behind: z.number().int(),
  branch: z.string(),
  repoIdentity: z.string().nullable().optional(),
  hasStaged: z.boolean(),
  hasUnstaged: z.boolean(),
  gitAvailable: z.literal(true),
});

export interface CapturedGitPatch {
  patch: string;
  baseCommitSha: string | null;
  branch: string | null;
}

export type CapturedGitStatus = z.infer<typeof GitStatusPayloadSchema>;

export class SecureGitArtifactClient {
  constructor(
    private readonly env: Env,
    private readonly muscleSession: string,
    private readonly runId: string,
  ) {}

  async capturePatch(): Promise<CapturedGitPatch | null> {
    const payload = await this.executeGitAction("git_patch_capture", {});
    assertPluginSuccess(payload, "git_patch_capture");
    const output = parseJsonOutput(payload.output);
    const parsed = PatchCapturePayloadSchema.parse(output);
    return parsed.patch.trim().length > 0 ? parsed : null;
  }

  async getStatus(): Promise<CapturedGitStatus | null> {
    const payload = await this.executeGitAction("git_status", {});
    assertPluginSuccess(payload, "git_status");
    const output = parseJsonOutput(payload.output);
    const parsed = GitStatusPayloadSchema.safeParse(output);
    return parsed.success ? parsed.data : null;
  }

  async applyPatch(patch: string): Promise<void> {
    const dryRun = await this.executeGitAction("git_patch_apply", {
      patch,
      dryRun: true,
    });
    assertPluginSuccess(dryRun, "git_patch_apply --check");

    const applied = await this.executeGitAction("git_patch_apply", {
      patch,
      dryRun: false,
    });
    assertPluginSuccess(applied, "git_patch_apply");
  }

  private async executeGitAction(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<PluginSuccessPayload | PluginErrorPayload> {
    const secureSession = await this.createSecureSession(action);
    const response = await this.env.SECURE_API.fetch(
      buildSecureApiUrl(this.muscleSession, "/api/v1/execute"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secureSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: secureSession.sessionId,
          taskId: `edit-artifact-${action}-${this.runId}`,
          action: "git.execute",
          params: {
            action,
            runId: this.runId,
            ...payload,
          },
          timeout: 20_000,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Git ${action} failed with HTTP ${response.status}`);
    }

    return normalizeCanonicalGitResponse((await response.json()) as unknown);
  }

  private async createSecureSession(
    action: string,
  ): Promise<SecureMuscleSession> {
    const response = await this.env.SECURE_API.fetch(
      buildSecureApiUrl(this.muscleSession, "/api/v1/session"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: this.runId,
          taskId: `edit-artifact-${action}-${this.runId}`,
          repoPath: ".",
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Git ${action} failed to create execution session with HTTP ${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      sessionId?: unknown;
      token?: unknown;
    };
    if (
      typeof payload.sessionId !== "string" ||
      typeof payload.token !== "string"
    ) {
      throw new Error("Git execution session response is missing credentials");
    }

    return {
      sessionId: payload.sessionId,
      token: payload.token,
    };
  }
}

function buildSecureApiUrl(muscleSession: string, pathname: string): string {
  const url = new URL(pathname, "http://internal/");
  url.searchParams.set("session", muscleSession);
  return url.toString();
}

function normalizeCanonicalGitResponse(
  payload: unknown,
): PluginSuccessPayload | PluginErrorPayload {
  const response = parseCanonicalExecutionResponse(payload);
  if (response.status === "success") {
    return { success: true, output: response.output };
  }
  return {
    success: false,
    error: response.error?.message ?? `Git execution ${response.status}`,
  };
}

function parseCanonicalExecutionResponse(
  payload: unknown,
): CanonicalExecutionResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("Git execution returned an invalid response payload");
  }
  const candidate = payload as CanonicalExecutionResponse;
  if (
    typeof candidate.taskId !== "string" ||
    !["success", "failure", "timeout", "cancelled"].includes(candidate.status)
  ) {
    throw new Error("Git execution returned an invalid canonical response");
  }
  return candidate;
}

function assertPluginSuccess(
  payload: PluginSuccessPayload | PluginErrorPayload,
  action: string,
): asserts payload is PluginSuccessPayload {
  if (payload.success) {
    return;
  }
  throw new Error(`Git ${action} failed: ${payload.error ?? "unknown error"}`);
}

function parseJsonOutput(output: unknown): unknown {
  if (typeof output !== "string") {
    return output;
  }
  return JSON.parse(output) as unknown;
}
