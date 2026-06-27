import {
  ArtifactEventSchema,
  ArtifactMetadataSchema,
  type ArtifactEvent,
  type ArtifactId,
  type ArtifactMetadata,
  type EventCursor,
  type EventId,
  type RunId,
} from "@repo/platform-protocol";
import { z } from "zod";

export const ARTIFACT_METADATA_VERSION = 1;
export const artifactMetadataVersion = ARTIFACT_METADATA_VERSION;

export const ArtifactMetadataRecordSchema = ArtifactMetadataSchema.extend({
  sourceEventId: z.custom<EventId>(),
  sourceCursor: z.custom<EventCursor>(),
  projectionVersion: z.literal(ARTIFACT_METADATA_VERSION),
}).strict();
export type ArtifactMetadataRecord = z.infer<
  typeof ArtifactMetadataRecordSchema
>;

export interface ArtifactMetadataRepository {
  putArtifactFromEvent(event: ArtifactEvent): Promise<ArtifactMetadataRecord>;
  getArtifact(
    artifactId: ArtifactId,
  ): Promise<ArtifactMetadataRecord | null>;
  listArtifactsByRun(runId: RunId): Promise<ArtifactMetadataRecord[]>;
}

export function projectArtifactMetadataEvent(
  event: ArtifactEvent,
): ArtifactMetadataRecord {
  const parsedEvent = ArtifactEventSchema.parse(event);
  return ArtifactMetadataRecordSchema.parse({
    ...parsedEvent.payload.artifact,
    sourceEventId: parsedEvent.eventId,
    sourceCursor: parsedEvent.cursor,
    projectionVersion: ARTIFACT_METADATA_VERSION,
  });
}
