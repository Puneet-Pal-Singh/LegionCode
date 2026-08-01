import { z } from "zod";
import type { SecureExecutionWorkspaceScope } from "../../runtime/RuntimeWorkspaceScope";
import type { Env } from "../../types/ai";
import type { SecureExecutionSessionPort } from "../secure-execution/SecureExecutionSessionClient";

interface PluginSuccessPayload {
  success: true;
  output?: unknown;
}

interface PluginErrorPayload {
  success: false;
  error?: string;
}

const PatchCapturePayloadSchema = z.object({
  patch: z.string(),
  baseCommitSha: z.string().min(1).nullable(),
  branch: z.string().min(1).nullable(),
});
const WorktreeSnapshotPayloadSchema = z.object({
  treeSha: z.string().regex(/^[a-f0-9]{40,64}$/iu),
});
const SnapshotDiffPayloadSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      previousPath: z.string().min(1).nullable(),
      status: z.enum([
        "added",
        "copied",
        "deleted",
        "modified",
        "renamed",
        "type_changed",
        "unmerged",
        "untracked",
      ]),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
  ),
  patch: z.string(),
});
const CanonicalExecutionResponseSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["success", "failure", "timeout", "cancelled"]),
  output: z.string().optional(),
  error: z
    .object({
      message: z.string().optional(),
    })
    .optional(),
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

type CanonicalExecutionResponse = z.infer<
  typeof CanonicalExecutionResponseSchema
>;
export type CapturedGitStatus = z.infer<typeof GitStatusPayloadSchema>;
export type CapturedGitSnapshotDiff = z.infer<typeof SnapshotDiffPayloadSchema>;

export class SecureGitArtifactClient {
  constructor(
    private readonly env: Env,
    private readonly brainSessionId: string,
    private readonly runId: string,
    private readonly workspaceScope: SecureExecutionWorkspaceScope,
    private readonly executionSession: SecureExecutionSessionPort,
  ) {}

  async capturePatch(input: {
    baselineTree: string;
    files: string[];
  }): Promise<CapturedGitPatch | null> {
    const payload = await this.executeGitAction("git_patch_capture", input);
    assertPluginSuccess(payload, "git_patch_capture");
    const output = parseJsonOutput(payload.output);
    const parsed = PatchCapturePayloadSchema.parse(output);
    return parsed.patch.trim().length > 0 ? parsed : null;
  }

  async captureWorktreeSnapshot(): Promise<string> {
    const payload = await this.executeGitAction("git_worktree_snapshot", {});
    assertPluginSuccess(payload, "git_worktree_snapshot");
    return WorktreeSnapshotPayloadSchema.parse(parseJsonOutput(payload.output))
      .treeSha;
  }

  async diffWorktreeSnapshots(input: {
    startTree: string;
    terminalTree: string;
  }): Promise<CapturedGitSnapshotDiff> {
    const payload = await this.executeGitAction("git_snapshot_diff", input);
    assertPluginSuccess(payload, "git_snapshot_diff");
    const parsed = SnapshotDiffPayloadSchema.safeParse(
      parseJsonOutput(payload.output),
    );
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Git snapshot diff contract mismatch: ${issues}`);
    }
    return parsed.data;
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
    const secureSession = await this.executionSession.acquire();
    const response = await this.env.SECURE_API.fetch(
      buildSecureApiUrl(this.brainSessionId, "/api/v1/execute"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secureSession.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionId: secureSession.sessionId,
          // Secure Agent API includes this value in a signed runtime-event
          // idempotency key together with the run, session, and event type.
          // Keep it opaque and bounded; repeating the action/run here can push
          // otherwise valid internal Git operations past the 200 byte contract.
          taskId: `artifact-${crypto.randomUUID()}`,
          action: "git.execute",
          params: {
            action,
            runId: this.runId,
            workspaceScope: this.workspaceScope,
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
  return CanonicalExecutionResponseSchema.parse(payload);
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
