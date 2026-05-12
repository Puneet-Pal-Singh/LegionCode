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
    const expiredArtifacts = await repository.listExpiredArtifacts(now);

    for (const artifact of expiredArtifacts) {
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
    }

    return { expiredCount: expiredArtifacts.length, repairedPendingCount };
  }
}

async function repairStalePendingArtifacts(
  repository: D1EditArtifactRepository,
  now: string,
): Promise<number> {
  const staleArtifacts = await repository.listStalePendingArtifacts(
    pendingRepairCutoff(now),
  );

  for (const artifact of staleArtifacts) {
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
  }

  return staleArtifacts.length;
}

function pendingRepairCutoff(now: string): string {
  return new Date(
    new Date(now).getTime() - PENDING_CAPTURE_REPAIR_WINDOW_MS,
  ).toISOString();
}
