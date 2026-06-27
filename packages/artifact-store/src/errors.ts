export type ArtifactStoreErrorCode =
  | "artifact_access_denied"
  | "artifact_checksum_mismatch"
  | "artifact_idempotency_conflict"
  | "artifact_not_found"
  | "artifact_payload_not_found"
  | "invalid_artifact_input";

export class ArtifactStoreError extends Error {
  constructor(
    readonly code: ArtifactStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}
