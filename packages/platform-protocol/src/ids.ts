import { z } from "zod";

export type PlatformId<TName extends string> = string & z.BRAND<TName>;

export const PLATFORM_ID_PREFIXES = {
  user: "usr",
  organization: "org",
  workspace: "wrk",
  thread: "thr",
  run: "run",
  turn: "trn",
  item: "itm",
  toolCall: "toolcall",
  approval: "appr",
  artifact: "art",
  workspaceManifest: "wsm",
  event: "evt",
  eventCursor: "cursor",
  worker: "worker",
  permissionProfile: "perm",
} as const;

export const PLATFORM_SLUG_LIMITS = {
  providerIdMaxLength: 64,
  modelIdMaxLength: 192,
} as const;

const ID_SUFFIX_PATTERN = "[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}";
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,191}$/;

function createPrefixedIdSchema<TName extends string>(
  name: TName,
  prefix: string,
): z.ZodBranded<z.ZodString, TName> {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}_${ID_SUFFIX_PATTERN}$`),
      `${name} must use ${prefix}_ prefix and an opaque suffix`,
    )
    .brand<TName>();
}

function createSlugIdSchema<TName extends string>(
  name: TName,
  pattern: RegExp,
  maxLength: number,
): z.ZodBranded<z.ZodString, TName> {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .regex(pattern, `${name} must be a stable protocol identifier`)
    .brand<TName>();
}

export const UserIdSchema = createPrefixedIdSchema(
  "UserId",
  PLATFORM_ID_PREFIXES.user,
);
export type UserId = z.infer<typeof UserIdSchema>;

export const OrganizationIdSchema = createPrefixedIdSchema(
  "OrganizationId",
  PLATFORM_ID_PREFIXES.organization,
);
export type OrganizationId = z.infer<typeof OrganizationIdSchema>;

export const WorkspaceIdSchema = createPrefixedIdSchema(
  "WorkspaceId",
  PLATFORM_ID_PREFIXES.workspace,
);
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const ThreadIdSchema = createPrefixedIdSchema(
  "ThreadId",
  PLATFORM_ID_PREFIXES.thread,
);
export type ThreadId = z.infer<typeof ThreadIdSchema>;

export const RunIdSchema = createPrefixedIdSchema(
  "RunId",
  PLATFORM_ID_PREFIXES.run,
);
export type RunId = z.infer<typeof RunIdSchema>;

export const TurnIdSchema = createPrefixedIdSchema(
  "TurnId",
  PLATFORM_ID_PREFIXES.turn,
);
export type TurnId = z.infer<typeof TurnIdSchema>;

export const ItemIdSchema = createPrefixedIdSchema(
  "ItemId",
  PLATFORM_ID_PREFIXES.item,
);
export type ItemId = z.infer<typeof ItemIdSchema>;

export const ToolCallIdSchema = createPrefixedIdSchema(
  "ToolCallId",
  PLATFORM_ID_PREFIXES.toolCall,
);
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;

export const ApprovalIdSchema = createPrefixedIdSchema(
  "ApprovalId",
  PLATFORM_ID_PREFIXES.approval,
);
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;

export const ArtifactIdSchema = createPrefixedIdSchema(
  "ArtifactId",
  PLATFORM_ID_PREFIXES.artifact,
);
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const WorkspaceManifestIdSchema = createPrefixedIdSchema(
  "WorkspaceManifestId",
  PLATFORM_ID_PREFIXES.workspaceManifest,
);
export type WorkspaceManifestId = z.infer<
  typeof WorkspaceManifestIdSchema
>;

export const EventIdSchema = createPrefixedIdSchema(
  "EventId",
  PLATFORM_ID_PREFIXES.event,
);
export type EventId = z.infer<typeof EventIdSchema>;

export const EventCursorSchema = createPrefixedIdSchema(
  "EventCursor",
  PLATFORM_ID_PREFIXES.eventCursor,
);
export type EventCursor = z.infer<typeof EventCursorSchema>;

export const WorkerIdSchema = createPrefixedIdSchema(
  "WorkerId",
  PLATFORM_ID_PREFIXES.worker,
);
export type WorkerId = z.infer<typeof WorkerIdSchema>;

export const ProviderIdSchema = createSlugIdSchema(
  "ProviderId",
  PROVIDER_ID_PATTERN,
  PLATFORM_SLUG_LIMITS.providerIdMaxLength,
);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ModelIdSchema = createSlugIdSchema(
  "ModelId",
  MODEL_ID_PATTERN,
  PLATFORM_SLUG_LIMITS.modelIdMaxLength,
);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const PermissionProfileIdSchema = createPrefixedIdSchema(
  "PermissionProfileId",
  PLATFORM_ID_PREFIXES.permissionProfile,
);
export type PermissionProfileId = z.infer<
  typeof PermissionProfileIdSchema
>;

export const PlatformIdSchemas = {
  UserId: UserIdSchema,
  OrganizationId: OrganizationIdSchema,
  WorkspaceId: WorkspaceIdSchema,
  ThreadId: ThreadIdSchema,
  RunId: RunIdSchema,
  TurnId: TurnIdSchema,
  ItemId: ItemIdSchema,
  ToolCallId: ToolCallIdSchema,
  ApprovalId: ApprovalIdSchema,
  ArtifactId: ArtifactIdSchema,
  WorkspaceManifestId: WorkspaceManifestIdSchema,
  EventId: EventIdSchema,
  EventCursor: EventCursorSchema,
  WorkerId: WorkerIdSchema,
  ProviderId: ProviderIdSchema,
  ModelId: ModelIdSchema,
  PermissionProfileId: PermissionProfileIdSchema,
} as const;

export type PlatformIdSchemaName = keyof typeof PlatformIdSchemas;
