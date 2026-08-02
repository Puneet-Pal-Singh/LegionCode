import type { Env } from "../../types/ai";
import type { EditArtifactStorageBackend } from "./EditArtifactStorageBackend";
import { R2PostgresEditArtifactStorageBackend } from "./R2PostgresEditArtifactStorageBackend";

export function createEditArtifactStorageBackend(
  env: Env,
): EditArtifactStorageBackend {
  return createCanonicalEditArtifactStorageBackend(env);
}

export function createCanonicalEditArtifactStorageBackend(
  env: Env,
): EditArtifactStorageBackend {
  if (!env.EDIT_ARTIFACTS) {
    throw new Error("EDIT_ARTIFACTS binding is unavailable");
  }

  return new R2PostgresEditArtifactStorageBackend(env.EDIT_ARTIFACTS);
}
