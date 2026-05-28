import type {
  EditArtifactStorageBackend,
  StoredEditArtifact,
  WriteEditArtifactInput,
} from "./EditArtifactStorageBackend";

export interface CompositeEditArtifactStorageResult extends StoredEditArtifact {
  secondary?: StoredEditArtifact;
  secondaryError?: string;
}

export class CompositeEditArtifactStorageBackend
  implements EditArtifactStorageBackend
{
  constructor(
    private readonly primary: EditArtifactStorageBackend,
    private readonly secondary?: EditArtifactStorageBackend,
  ) {}

  async writeArtifact(
    input: WriteEditArtifactInput,
  ): Promise<CompositeEditArtifactStorageResult> {
    const primaryResult = await this.primary.writeArtifact(input);
    if (!this.secondary) {
      return primaryResult;
    }

    try {
      const secondary = await this.secondary.writeArtifact(input);
      return { ...primaryResult, secondary };
    } catch (error) {
      const secondaryError =
        error instanceof Error ? error.message : "Secondary write failed";
      return { ...primaryResult, secondaryError };
    }
  }

  async readPatch(input: Parameters<EditArtifactStorageBackend["readPatch"]>[0]) {
    return await this.primary.readPatch(input);
  }

  async deleteArtifact(
    input: Parameters<EditArtifactStorageBackend["deleteArtifact"]>[0],
  ) {
    await this.primary.deleteArtifact(input);
    if (this.secondary) {
      try {
        await this.secondary.deleteArtifact(input);
      } catch (error) {
        console.warn("[edit-artifacts/storage] Secondary delete failed", {
          artifactId: input.artifact.id,
          error,
        });
      }
    }
  }
}
