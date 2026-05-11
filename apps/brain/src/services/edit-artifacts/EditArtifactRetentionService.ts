import type { Env } from "../../types/ai";
import { ensureByokSchemaReady } from "../byok/ByokSchemaService";
import { D1EditArtifactRepository } from "./D1EditArtifactRepository";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";

export class EditArtifactRetentionService {
  constructor(private readonly env: Env) {}

  async expireArtifacts(now: string = new Date().toISOString()): Promise<{
    expiredCount: number;
  }> {
    if (!this.env.EDIT_ARTIFACTS) {
      return { expiredCount: 0 };
    }

    await ensureByokSchemaReady(this.env.BYOK_DB);
    const repository = new D1EditArtifactRepository(this.env.BYOK_DB);
    const objectStore = new EditArtifactObjectStore(this.env.EDIT_ARTIFACTS);
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

    return { expiredCount: expiredArtifacts.length };
  }
}
