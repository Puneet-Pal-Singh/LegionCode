import {
  ArtifactMetadataSchema,
  type ArtifactMetadata,
  type ItemId,
  type JsonRecord,
  type Run,
} from "@repo/platform-protocol";
import type { WorkerToolRuntimeEvent } from "./types.js";

export interface WorkerResultEventProjection {
  readonly outputDeltas: readonly string[];
  readonly artifacts: readonly ArtifactMetadata[];
}

export function mapWorkerResultEvents(
  run: Run,
  itemId: ItemId,
  output: JsonRecord,
  events: readonly WorkerToolRuntimeEvent[] = [],
): WorkerResultEventProjection {
  return {
    outputDeltas: collectOutputDeltas(output, events),
    artifacts: collectArtifacts(run, itemId, output, events),
  };
}

function collectOutputDeltas(
  output: JsonRecord,
  events: readonly WorkerToolRuntimeEvent[],
): string[] {
  return [
    ...events.flatMap((event) =>
      event.type === "tool_output_delta" ? [event.delta] : [],
    ),
    ...collectCommandOutputDeltas(output),
  ].filter(hasContent);
}

function collectCommandOutputDeltas(output: JsonRecord): string[] {
  const stdout = readString(output, "stdout");
  const stderr = readString(output, "stderr");
  return [stdout, stderr].filter(hasContent);
}

function collectArtifacts(
  run: Run,
  itemId: ItemId,
  output: JsonRecord,
  events: readonly WorkerToolRuntimeEvent[],
): ArtifactMetadata[] {
  const artifacts = events.flatMap((event) =>
    event.type === "artifact_created" ? [event.artifact] : [],
  );
  return [...artifacts, ...collectOutputArtifacts(run, itemId, output)];
}

function collectOutputArtifacts(
  run: Run,
  itemId: ItemId,
  output: JsonRecord,
): ArtifactMetadata[] {
  const direct = parseArtifactProjection(run, itemId, output);
  if (direct !== null) {
    return [direct];
  }
  const nested = parseArtifactProjection(run, itemId, output.artifact);
  return nested === null ? [] : [nested];
}

function parseArtifactProjection(
  run: Run,
  itemId: ItemId,
  value: unknown,
): ArtifactMetadata | null {
  const parsed = ArtifactMetadataSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  const canonical = parseCanonicalArtifact(value);
  return canonical === null
    ? null
    : ArtifactMetadataSchema.parse({
        artifactId: canonical.artifactId,
        threadId: canonical.ownership.threadId,
        runId: canonical.ownership.runId,
        workspaceId: canonical.ownership.workspaceId,
        itemId,
        kind: canonical.kind === "patch" ? "git_patch" : canonical.kind,
        label: readLabel(canonical.properties, canonical.kind),
        payloadRef: {
          backend: canonical.payload.backend === "memory"
            ? "local_blob"
            : canonical.payload.backend,
          objectKey: canonical.payload.storageKey,
          uri: null,
          contentType: canonical.payload.contentType,
          sizeBytes: canonical.payload.byteSize,
          sha256: canonical.payload.sha256,
        },
        changedFiles: [],
        metadata: {
          ...canonical.properties,
          visibility: canonical.visibility,
          createdBy: canonical.ownership.createdBy,
          source: "artifact_store",
        },
        createdAt: canonical.createdAt,
        eventSequence: run.lastEventSequence,
      });
}

function readString(output: JsonRecord, key: string): string | null {
  const value = output[key];
  return typeof value === "string" ? value : null;
}

function hasContent(value: string | null): value is string {
  return value !== null && value.length > 0;
}

interface CanonicalArtifactMetadata {
  readonly artifactId: string;
  readonly kind: string;
  readonly ownership: {
    readonly createdBy: string;
    readonly workspaceId: string;
    readonly threadId: string;
    readonly runId: string;
  };
  readonly visibility: string;
  readonly payload: {
    readonly backend: string;
    readonly storageKey: string;
    readonly contentType: string;
    readonly byteSize: number;
    readonly sha256: string;
  };
  readonly properties: JsonRecord;
  readonly createdAt: string;
}

function parseCanonicalArtifact(
  value: unknown,
): CanonicalArtifactMetadata | null {
  if (!isRecord(value)) {
    return null;
  }
  const artifact = {
    artifactId: readRequiredString(value, "artifactId"),
    kind: readRequiredString(value, "kind"),
    ownership: parseCanonicalOwnership(value.ownership),
    visibility: readRequiredString(value, "visibility"),
    payload: parseCanonicalPayload(value.payload),
    properties: parseJsonRecord(value.properties),
    createdAt: readRequiredString(value, "createdAt"),
  };
  return hasCanonicalArtifactFields(artifact) ? artifact : null;
}

function parseCanonicalOwnership(
  value: unknown,
): CanonicalArtifactMetadata["ownership"] | null {
  if (!isRecord(value)) {
    return null;
  }
  const createdBy = readRequiredString(value, "createdBy");
  const workspaceId = readRequiredString(value, "workspaceId");
  const threadId = readRequiredString(value, "threadId");
  const runId = readRequiredString(value, "runId");
  if (
    createdBy === null ||
    workspaceId === null ||
    threadId === null ||
    runId === null
  ) {
    return null;
  }
  return { createdBy, workspaceId, threadId, runId };
}

function parseCanonicalPayload(
  value: unknown,
): CanonicalArtifactMetadata["payload"] | null {
  if (!isRecord(value)) {
    return null;
  }
  const backend = readRequiredString(value, "backend");
  const storageKey = readRequiredString(value, "storageKey");
  const contentType = readRequiredString(value, "contentType");
  const byteSize = readRequiredNumber(value, "byteSize");
  const sha256 = readRequiredString(value, "sha256");
  if (
    backend === null ||
    storageKey === null ||
    contentType === null ||
    byteSize === null ||
    sha256 === null
  ) {
    return null;
  }
  return { backend, storageKey, contentType, byteSize, sha256 };
}

function hasCanonicalArtifactFields(
  artifact: {
    readonly artifactId: string | null;
    readonly kind: string | null;
    readonly ownership: CanonicalArtifactMetadata["ownership"] | null;
    readonly visibility: string | null;
    readonly payload: CanonicalArtifactMetadata["payload"] | null;
    readonly properties: JsonRecord | null;
    readonly createdAt: string | null;
  },
): artifact is CanonicalArtifactMetadata {
  return Object.values(artifact).every((field) => field !== null);
}

function parseJsonRecord(value: unknown): JsonRecord | null {
  return isJsonRecord(value) ? value : null;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonRecord(value);
}

function readLabel(properties: JsonRecord, kind: string): string {
  const label = properties.label;
  return typeof label === "string" && label.length > 0 ? label : kind;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readRequiredNumber(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
