import type { Env } from "../../types/ai";
import { withArtifactRepository } from "./ArtifactPersistenceFactory";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import { sha256Hex } from "./EditArtifactStorageBackend";

export type ReconciliationStatus =
  | "reconciled"
  | "reconciliation_failed"
  | "requires_user_resolution";

export interface ReconciliationResult {
  artifactId: string;
  status: ReconciliationStatus;
  r2PatchSha256: string | null;
  cloudflarePatchSha256: string | null;
}

export class EditArtifactStorageReconciliationService {
  constructor(private readonly env: Env) {}

  async reconcileArtifact(input: {
    artifactId: string;
    userId: string;
    cloudflarePatch?: string | null;
  }): Promise<ReconciliationResult> {
    const artifact = await withArtifactRepository(this.env, (repository) =>
      repository.getArtifactById(input.artifactId, input.userId),
    );
    if (!artifact || !this.env.EDIT_ARTIFACTS) {
      return this.unresolved(input.artifactId);
    }

    const objectStore = new EditArtifactObjectStore(this.env.EDIT_ARTIFACTS);
    const r2Patch = await objectStore.readPatch(artifact.r2ObjectKey);
    if (!r2Patch || !input.cloudflarePatch) {
      return this.unresolved(input.artifactId);
    }

    const r2PatchSha256 = await sha256Hex(r2Patch);
    const cloudflarePatchSha256 = await sha256Hex(input.cloudflarePatch);
    const status =
      r2PatchSha256 === cloudflarePatchSha256
        ? "reconciled"
        : "reconciliation_failed";

    await withArtifactRepository(this.env, (repository) =>
      repository.updateReviewMetadata({
        artifactId: artifact.id,
        userId: artifact.userId,
        storageReconciliationStatus: status,
      }),
    );

    return {
      artifactId: artifact.id,
      status,
      r2PatchSha256,
      cloudflarePatchSha256,
    };
  }

  private unresolved(artifactId: string): ReconciliationResult {
    return {
      artifactId,
      status: "requires_user_resolution",
      r2PatchSha256: null,
      cloudflarePatchSha256: null,
    };
  }
}
