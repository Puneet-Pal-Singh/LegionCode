import type { Env } from "../../types/ai";
import { CloudflareArtifactsEditArtifactStorageBackend } from "./CloudflareArtifactsEditArtifactStorageBackend";
import { CompositeEditArtifactStorageBackend } from "./CompositeEditArtifactStorageBackend";
import type { EditArtifactStorageBackend } from "./EditArtifactStorageBackend";
import { R2PostgresEditArtifactStorageBackend } from "./R2PostgresEditArtifactStorageBackend";

export function createEditArtifactStorageBackend(
  env: Env,
): EditArtifactStorageBackend {
  if (!env.EDIT_ARTIFACTS) {
    throw new Error("EDIT_ARTIFACTS binding is unavailable");
  }

  const primary = new R2PostgresEditArtifactStorageBackend(env.EDIT_ARTIFACTS);
  if (!isEnabled(env.EDIT_ARTIFACTS_CF_ARTIFACTS_WRITE)) {
    return primary;
  }

  const artifacts = readArtifactsBinding(env.ARTIFACTS);
  if (!artifacts) {
    throw new Error(
      "ARTIFACTS binding is required when EDIT_ARTIFACTS_CF_ARTIFACTS_WRITE is enabled",
    );
  }

  return new CompositeEditArtifactStorageBackend(
    primary,
    new CloudflareArtifactsEditArtifactStorageBackend(artifacts),
  );
}

function isEnabled(value: string | undefined): boolean {
  return value?.toLowerCase() === "true" || value === "1";
}

function readArtifactsBinding(value: unknown): ConstructorParameters<
  typeof CloudflareArtifactsEditArtifactStorageBackend
>[0] | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("create" in value) ||
    !("get" in value)
  ) {
    return null;
  }
  return value as ConstructorParameters<
    typeof CloudflareArtifactsEditArtifactStorageBackend
  >[0];
}
