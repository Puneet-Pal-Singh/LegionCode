import { lstat, realpath } from "node:fs/promises";
import type { TurnArtifactRepository } from "@repo/artifact-store";
import type { LifecycleEventStore } from "@repo/event-store";
import type { LocalPersistence } from "@repo/event-store/local";
import type { DefaultGitService, GitCommitResult } from "@repo/git-service";
import {
  ArtifactIdSchema,
  WorkspaceIdSchema,
  ThreadIdSchema,
  RunIdSchema,
  TurnIdSchema,
  RunAttemptIdSchema,
  TurnDiffPayloadSchema,
  type LocalWorkspaceGrant,
  type WorkspaceId,
} from "@repo/platform-protocol";
import { TurnAdmissionSchema } from "@repo/platform-protocol/conversation";
import { z } from "zod";

const CommandSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    threadId: ThreadIdSchema,
    runId: RunIdSchema,
    turnId: TurnIdSchema,
    runAttemptId: RunAttemptIdSchema,
    artifactId: ArtifactIdSchema,
    message: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .regex(/^[^\0\r\n]+$/),
    author: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^\0\r\n]+$/),
        email: z.string().email().max(320),
      })
      .strict()
      .optional(),
  })
  .strict();

export type LocalArtifactCommitCommand = z.infer<typeof CommandSchema>;
export type LocalGitWorkspaceBinding = {
  readonly workspace: LocalWorkspaceGrant;
  readonly filesystemRoot: string;
  readonly signal: AbortSignal;
  assertCurrent(): void;
};
export type LocalGitServiceOptions = {
  workspaceGrants: LocalPersistence["workspaceGrants"];
  getAdmission: LocalPersistence["turnAdmissions"]["getByTurn"];
  lifecycleEvents: Pick<LifecycleEventStore, "replay">;
  artifacts: Pick<TurnArtifactRepository, "getTurnDiff">;
  gitService: Pick<
    DefaultGitService,
    "commit" | "readConfigValue" | "probeRepository"
  >;
  /** Existing host grant/lease owner must retain this binding for the callback. */
  withWorkspaceGrant<T>(
    workspaceId: WorkspaceId,
    operation: (binding: LocalGitWorkspaceBinding) => Promise<T>,
  ): Promise<T>;
};

export class LocalGitOperationError extends Error {
  constructor(
    readonly code:
      | "workspace_unavailable"
      | "artifact_unavailable"
      | "identity_mismatch"
      | "artifact_conflict"
      | "commit_identity_required",
    message: string,
  ) {
    super(message);
    this.name = "LocalGitOperationError";
  }
}

/** Authorizes immutable Turn output; DefaultGitService remains the Git owner. */
export class LocalGitService {
  constructor(private readonly options: LocalGitServiceOptions) {}

  async commit(input: LocalArtifactCommitCommand): Promise<GitCommitResult> {
    const command = CommandSchema.parse(input);
    const rawAdmission = await this.options.getAdmission(command.turnId);
    if (!rawAdmission)
      throw new LocalGitOperationError(
        "identity_mismatch",
        "Local Turn admission is unavailable",
      );
    const admission = TurnAdmissionSchema.parse(rawAdmission);
    if (
      admission.run.workspaceId !== command.workspaceId ||
      admission.run.threadId !== command.threadId ||
      admission.run.id !== command.runId ||
      admission.turn.id !== command.turnId ||
      admission.runAttemptId !== command.runAttemptId
    ) {
      throw new LocalGitOperationError(
        "identity_mismatch",
        "Commit identity does not match the admitted Turn",
      );
    }
    const stored = await this.options.artifacts.getTurnDiff(command.turnId, {
      userId: admission.run.userId,
      workspaceId: command.workspaceId,
      threadId: command.threadId,
      runId: command.runId,
    });
    if (!stored)
      throw new LocalGitOperationError(
        "artifact_unavailable",
        "Immutable Turn diff is unavailable",
      );
    const owner = stored.metadata.ownership;
    if (
      stored.metadata.artifactId !== command.artifactId ||
      owner.createdBy !== admission.run.userId ||
      owner.workspaceId !== command.workspaceId ||
      owner.threadId !== command.threadId ||
      owner.runId !== command.runId
    ) {
      throw new LocalGitOperationError(
        "identity_mismatch",
        "Selected artifact does not belong to this Turn",
      );
    }
    const diff = TurnDiffPayloadSchema.parse(stored.payload);
    if (
      diff.turnId !== command.turnId ||
      diff.startSnapshot.phase !== "start" ||
      diff.terminalSnapshot.phase !== "terminal" ||
      diff.startSnapshot.headSha !== diff.terminalSnapshot.headSha
    ) {
      throw new LocalGitOperationError(
        "artifact_conflict",
        "Artifact snapshots do not describe one stable captured Turn",
      );
    }
    await this.requireTerminalArtifact(command);
    const paths = [
      ...new Set(
        diff.files
          .filter((file) => file.status !== "unchanged")
          .flatMap((file) =>
            file.status === "renamed" && file.previousPath
              ? [file.previousPath, file.path]
              : [file.path],
          ),
      ),
    ];
    if (paths.length === 0)
      throw new LocalGitOperationError(
        "artifact_unavailable",
        "Selected artifact has no changed files",
      );

    return await this.options.withWorkspaceGrant(
      command.workspaceId,
      async (binding) => {
        const assertCurrent = () => {
          binding.signal.throwIfAborted();
          binding.assertCurrent();
        };
        const requireGrant = async () => {
          assertCurrent();
          const saved = await this.options.workspaceGrants.read();
          assertCurrent();
          if (
            !saved ||
            saved.grant.workspaceId !== command.workspaceId ||
            saved.grant.readiness !== "ready" ||
            binding.workspace.workspaceId !== command.workspaceId ||
            binding.workspace.readiness !== "ready" ||
            saved.grant.grantedAt !== binding.workspace.grantedAt ||
            saved.path !== binding.filesystemRoot
          ) {
            throw new LocalGitOperationError(
              "workspace_unavailable",
              "The original workspace grant is no longer current",
            );
          }
          const stats = await lstat(saved.path);
          const root = await realpath(saved.path);
          assertCurrent();
          if (
            !stats.isDirectory() ||
            stats.isSymbolicLink() ||
            root !== saved.path
          ) {
            throw new LocalGitOperationError(
              "workspace_unavailable",
              "Granted repository root changed",
            );
          }
          return saved;
        };
        const saved = await requireGrant();
        const probe = await this.options.gitService.probeRepository({
          workspaceRoot: saved.path,
        });
        assertCurrent();
        if (
          (await realpath(probe.repositoryRoot)) !== saved.path ||
          probe.repositoryIdentity !== saved.grant.repositoryIdentity
        ) {
          throw new LocalGitOperationError(
            "workspace_unavailable",
            "Granted repository identity changed",
          );
        }
        const workspace = { runId: command.runId, filesystemRoot: saved.path };
        const author = command.author ?? {
          name: await this.options.gitService.readConfigValue({
            workspace,
            key: "user.name",
          }),
          email: await this.options.gitService.readConfigValue({
            workspace,
            key: "user.email",
          }),
        };
        if (!author.name || !author.email)
          throw new LocalGitOperationError(
            "commit_identity_required",
            "A commit author is required",
          );
        const validatedAuthor = CommandSchema.shape.author
          .unwrap()
          .parse(author);
        await requireGrant();
        return await this.options.gitService.commit({
          workspace,
          paths,
          message: command.message,
          author: validatedAuthor,
          expectedTerminalTreeId: diff.terminalSnapshot.treeId,
          expectedBaselineTreeId: diff.startSnapshot.treeId,
          expectedHeadSha: diff.terminalSnapshot.headSha,
        });
      },
    );
  }

  private async requireTerminalArtifact(
    command: LocalArtifactCommitCommand,
  ): Promise<void> {
    let afterSequence: number | null = null;
    let artifactSaved = false;
    for (;;) {
      const page = await this.options.lifecycleEvents.replay({
        turnId: command.turnId,
        afterSequence,
        limit: 500,
      });
      for (const event of page.events) {
        if (
          event.threadId !== command.threadId ||
          event.turnId !== command.turnId ||
          event.runAttemptId !== command.runAttemptId
        ) {
          throw new LocalGitOperationError(
            "identity_mismatch",
            "Lifecycle evidence belongs to a different Turn attempt",
          );
        }
        if (event.type === "artifact.created") {
          const artifact = event.payload.artifact;
          if (
            typeof artifact === "object" &&
            artifact !== null &&
            !Array.isArray(artifact) &&
            artifact.artifactId === command.artifactId
          )
            artifactSaved = true;
        }
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted"
        ) {
          if (artifactSaved) return;
          throw new LocalGitOperationError(
            "artifact_unavailable",
            "Terminal Turn has no saved selected artifact",
          );
        }
      }
      if (
        page.events.length < 500 ||
        page.nextSequence === null ||
        page.nextSequence === afterSequence
      )
        break;
      afterSequence = page.nextSequence;
    }
    throw new LocalGitOperationError(
      "artifact_unavailable",
      "Turn has no terminal runtime evidence",
    );
  }
}
