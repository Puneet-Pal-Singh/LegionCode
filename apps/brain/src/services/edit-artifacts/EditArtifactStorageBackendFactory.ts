import type { Env } from "../../types/ai";
import {
  CloudflareArtifactsEditArtifactStorageBackend,
  type ArtifactsBinding,
} from "./CloudflareArtifactsEditArtifactStorageBackend";
import { CompositeEditArtifactStorageBackend } from "./CompositeEditArtifactStorageBackend";
import type { EditArtifactStorageBackend } from "./EditArtifactStorageBackend";
import { R2PostgresEditArtifactStorageBackend } from "./R2PostgresEditArtifactStorageBackend";

export function createEditArtifactStorageBackend(
  env: Env,
): EditArtifactStorageBackend {
  const primary = createCanonicalEditArtifactStorageBackend(env);
  if (!isEnabled(env.EDIT_ARTIFACTS_CF_ARTIFACTS_WRITE)) {
    return primary;
  }

  assertArtifactsBinding(env.ARTIFACTS);
  return new CompositeEditArtifactStorageBackend(
    primary,
    new CloudflareArtifactsEditArtifactStorageBackend(),
  );
}

export function createCanonicalEditArtifactStorageBackend(
  env: Env,
): EditArtifactStorageBackend {
  if (!env.EDIT_ARTIFACTS) {
    throw new Error("EDIT_ARTIFACTS binding is unavailable");
  }
  return new R2PostgresEditArtifactStorageBackend(env.EDIT_ARTIFACTS);
}

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function assertArtifactsBinding(value: unknown): asserts value is ArtifactsBinding {
  if (
    typeof value !== "object" ||
    value === null ||
    !("create" in value) ||
    !("get" in value)
  ) {
    throw new Error(
      "ARTIFACTS binding is required when EDIT_ARTIFACTS_CF_ARTIFACTS_WRITE is enabled",
    );
  }
}
