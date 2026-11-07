import { isDeepStrictEqual } from "node:util";
import type { LocalPersistence } from "@repo/event-store/local";
import {
  GetTurnDiffRequestSchema,
  GetTurnDiffResponseSchema,
  LifecycleEventSchema,
  TurnAdmissionSchema,
  TurnDiffPayloadSchema,
  type GetTurnDiffRequest,
  type GetTurnDiffResponse,
  type TurnAdmission,
  type TurnDiffPayload,
  type TurnId,
  type ArtifactId,
} from "@repo/platform-protocol";
import { AppServerOperationError } from "./server.js";

/** Query adapter only. The existing turn owner authorizes the current grant/thread. */
export class LocalTurnArtifactReads {
  constructor(
    private readonly options: {
      readonly turns: { getTurn(turnId: TurnId): Promise<TurnAdmission> };
      readonly persistence: Pick<
        LocalPersistence,
        "lifecycleEvents" | "turnArtifacts"
      >;
    },
  ) {}

  async getTurnDiff(input: GetTurnDiffRequest): Promise<GetTurnDiffResponse> {
    const verified = await this.loadVerifiedDiff(input);
    return GetTurnDiffResponseSchema.parse({
      diff: verified.saved?.diff ?? null,
    });
  }

  /** Internal immutable selection, not permission to mutate Git. The commit
   * owner must still verify artifact publication and the active grant. */
  async getTurnDiffArtifact(input: GetTurnDiffRequest): Promise<{
    readonly admission: TurnAdmission;
    readonly diff: TurnDiffPayload;
    readonly artifactId: ArtifactId;
  } | null> {
    const verified = await this.loadVerifiedDiff(input);
    return verified.saved
      ? {
          admission: verified.admission,
          diff: verified.saved.diff,
          artifactId: verified.saved.artifact.artifactId,
        }
      : null;
  }

  private async loadVerifiedDiff(input: GetTurnDiffRequest) {
    const request = GetTurnDiffRequestSchema.parse(input);
    if (request.backend !== undefined) {
      throw new AppServerOperationError(
        400,
        "invalid_request",
        "Local saved review does not accept a hosted backend",
      );
    }
    const admission = TurnAdmissionSchema.parse(
      await this.options.turns.getTurn(request.turnId),
    );
    if (admission.turn.id !== request.turnId) throw unavailable();
    const published = await this.readPublishedDiff(admission);
    const saved = published
      ? await this.options.persistence.turnArtifacts
          .forAttempt({
            userId: admission.run.userId,
            workspaceId: admission.run.workspaceId,
            threadId: admission.run.threadId,
            runId: admission.run.id,
            turnId: admission.turn.id,
            runAttemptId: admission.runAttemptId,
          })
          .getTurnDiff()
      : null;
    if (
      published &&
      (!saved ||
        !isDeepStrictEqual(TurnDiffPayloadSchema.parse(saved.diff), published))
    ) {
      throw unavailable();
    }
    // Grant revocation or a different thread scope during asynchronous reads
    // invalidates this response, without changing the immutable saved source.
    const current = TurnAdmissionSchema.parse(
      await this.options.turns.getTurn(request.turnId),
    );
    if (!isDeepStrictEqual(current, admission)) throw unavailable();
    return { admission, saved };
  }

  private async readPublishedDiff(
    admission: TurnAdmission,
  ): Promise<TurnDiffPayload | null> {
    let afterSequence: number | null = null;
    let sequence = 0;
    let terminal = false;
    let diff: TurnDiffPayload | null = null;
    const starts = ["turn.queued", "turn.started", "run_attempt.started"];
    do {
      const page = await this.options.persistence.lifecycleEvents.replay({
        turnId: admission.turn.id,
        afterSequence,
        limit: 1_000,
      });
      for (const raw of page.events) {
        const event = LifecycleEventSchema.parse(raw);
        if (
          terminal ||
          event.turnId !== admission.turn.id ||
          event.threadId !== admission.run.threadId ||
          event.runAttemptId !== admission.runAttemptId ||
          event.producer.id !== admission.run.workerId ||
          event.sequence !== sequence + 1 ||
          (sequence < starts.length && event.type !== starts[sequence]) ||
          (sequence >= starts.length && starts.includes(event.type))
        )
          throw unavailable();
        sequence = event.sequence;
        if (event.type === "turn.diff_updated") {
          diff = TurnDiffPayloadSchema.parse(event.payload.diff);
          if (diff.turnId !== admission.turn.id) throw unavailable();
        }
        if (event.type === "workspace.snapshot_unavailable") diff = null;
        if (
          event.type === "turn.completed" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted"
        ) {
          terminal = true;
        }
      }
      if (
        page.nextSequence !== null &&
        (page.events.length === 0 ||
          page.nextSequence !== sequence ||
          page.nextSequence <= (afterSequence ?? 0))
      )
        throw unavailable();
      afterSequence = page.nextSequence;
    } while (afterSequence !== null);
    // Persisted bytes alone are not publication. In-progress, omitted or
    // unavailable capture remains an honest null, without consulting live Git.
    return terminal ? diff : null;
  }
}

function unavailable(): AppServerOperationError {
  return new AppServerOperationError(
    503,
    "server_unavailable",
    "Saved turn review could not be verified",
  );
}
