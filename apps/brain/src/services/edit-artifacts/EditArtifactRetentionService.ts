import type { Env } from "../../types/ai";
import { ensureByokSchemaReady } from "../byok/ByokSchemaService";
import { D1EditArtifactRepository } from "./D1EditArtifactRepository";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";

const PENDING_CAPTURE_REPAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

export class EditArtifactRetentionService {
  constructor(private readonly env: Env) {}

  async expireArtifacts(now: string = new Date().toISOString()): Promise<{
    expiredCount: number;
    repairedPendingCount: number;
  }> {
    if (!this.env.EDIT_ARTIFACTS) {
      return { expiredCount: 0, repairedPendingCount: 0 };
    }

    await ensureByokSchemaReady(this.env.BYOK_DB);
    const repository = new D1EditArtifactRepository(this.env.BYOK_DB);
    const objectStore = new EditArtifactObjectStore(this.env.EDIT_ARTIFACTS);
    const repairedPendingCount = await repairStalePendingArtifacts(
      repository,
      now,
    );
    const expiredCount = await expireArtifacts(repository, objectStore, now);

    return { expiredCount, repairedPendingCount };
  }
}

async function expireArtifacts(
  repository: D1EditArtifactRepository,
  objectStore: EditArtifactObjectStore,
  now: string,
): Promise<number> {
  const expiredArtifacts = await repository.listExpiredArtifacts(now);
  let expiredCount = 0;

  for (const artifact of expiredArtifacts) {
    try {
      await objectStore.deletePatch(artifact.r2ObjectKey);
      await repository.updateStatus({
        artifactId: artifact.id,
        status: "expired",
      });
      await repository.appendEvent({
        id: crypto.randomUUID(),
        artifactId: artifact.id,
        runId: artifact.runId,
        eventType: "expired",
        message: "Expired edit artifact payload removed from R2",
      });
      expiredCount += 1;
    } catch (error) {
      console.error(
        `[edit-artifacts/retention] Failed to expire artifact ${artifact.id}`,
        error,
      );
    }
  }

  return expiredCount;
}

async function repairStalePendingArtifacts(
  repository: D1EditArtifactRepository,
  now: string,
): Promise<number> {
  const staleArtifacts = await repository.listStalePendingArtifacts(
    pendingRepairCutoff(now),
  );

  let repairedCount = 0;
  for (const artifact of staleArtifacts) {
    try {
      await repository.updateStatus({
        artifactId: artifact.id,
        status: "capture_failed",
      });
      await repository.appendEvent({
        id: crypto.randomUUID(),
        artifactId: artifact.id,
        runId: artifact.runId,
        eventType: "capture_failed",
        message: "Pending edit artifact capture exceeded repair window",
      });
      repairedCount += 1;
    } catch (error) {
      console.error(
        `[edit-artifacts/retention] Failed to repair stale artifact ${artifact.id}`,
        error,
      );
    }
  }

  return repairedCount;
}

function pendingRepairCutoff(now: string): string {
  return new Date(
    new Date(now).getTime() - PENDING_CAPTURE_REPAIR_WINDOW_MS,
  ).toISOString();
}
