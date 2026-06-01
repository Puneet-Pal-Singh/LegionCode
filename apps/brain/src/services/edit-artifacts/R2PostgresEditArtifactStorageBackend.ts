import type { R2Bucket } from "@cloudflare/workers-types";
import { EditArtifactObjectStore } from "./EditArtifactObjectStore";
import {
  sha256Hex,
  type EditArtifactStorageBackend,
  type StoredEditArtifact,
  type WriteEditArtifactInput,
} from "./EditArtifactStorageBackend";

export class R2PostgresEditArtifactStorageBackend
  implements EditArtifactStorageBackend
{
  private readonly objectStore: EditArtifactObjectStore;

  constructor(bucket: R2Bucket) {
    this.objectStore = new EditArtifactObjectStore(bucket);
  }

  async writeArtifact(
    input: WriteEditArtifactInput,
  ): Promise<StoredEditArtifact> {
    const patchSha256 = await sha256Hex(input.patch);
    await this.objectStore.writePatch({
      key: input.objectKey,
      patch: input.patch,
      metadata: {
        ...input.metadata,
        patchSha256,
        storageBackend: "r2_postgres",
      },
    });

    return {
      backend: "r2_postgres",
      objectKey: input.objectKey,
      patchSha256,
    };
  }

  async readPatch(input: Parameters<EditArtifactStorageBackend["readPatch"]>[0]) {
    return await this.objectStore.readPatch(input.artifact.r2ObjectKey);
  }

  async deleteArtifact(
    input: Parameters<EditArtifactStorageBackend["deleteArtifact"]>[0],
  ) {
    await this.objectStore.deletePatch(input.artifact.r2ObjectKey);
  }
}
