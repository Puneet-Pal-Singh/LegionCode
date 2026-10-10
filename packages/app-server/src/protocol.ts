import {
  APP_SERVER_PROTOCOL_VERSION,
  ConversationHistoryRequestSchema,
  ConversationHistoryResponseSchema,
  AppServerErrorSchema,
  AppServerInitializeResponseSchema,
  LocalWorkspaceGrantResponseSchema,
  ProviderIdSchema,
  ThreadIdSchema,
  ThreadSchema,
} from "@repo/platform-protocol";
import {
  BYOKDiscoveredProviderModelsResponseSchema,
  ProviderRegistryEntrySchema,
} from "@repo/shared-types";
import { z } from "zod";

export { APP_SERVER_PROTOCOL_VERSION, AppServerErrorSchema };

const EmptyParamsSchema = z.object({}).strict();
const ProviderSelectionSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1).max(256).refine((value) => value.trim() === value),
}).strict();
const ClientSchema = z
  .object({
    id: z.string().min(1).max(120),
    version: z.string().min(1).max(120),
  })
  .strict();
const WorkspaceGrantSourceSchema = z.union([
  z.object({ selectionToken: z.string().min(1).max(512) }).strict(),
  z.object({ path: z.string().min(1).max(4_096) }).strict(),
]);

export const ThreadCreateParamsSchema = z
  .object({ title: z.string().trim().min(1).max(80).optional() })
  .strict();
export const ThreadRenameParamsSchema = z
  .object({ threadId: ThreadIdSchema, title: z.string().trim().min(1).max(80) })
  .strict();

export const AppServerMethodSchema = z.enum([
  "initialize",
  "session/history",
  "workspace/current",
  "workspace/grant",
  "workspace/revoke",
  "thread/list",
  "thread/create",
  "thread/get",
  "thread/rename",
  "thread/archive",
  "thread/unarchive",
  "provider/catalog",
  "provider/models",
  "provider/current",
  "provider/select",
  "provider/clear",
]);

const AppServerRequestShape = {
  protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
};

export const AppServerRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...AppServerRequestShape, method: z.literal("session/history"), params: ConversationHistoryRequestSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("initialize"), params: z.object({ client: ClientSchema, requestedCapabilities: z.array(z.string().min(1).max(120)).max(100) }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/current"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/grant"), params: WorkspaceGrantSourceSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("workspace/revoke"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/list"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/create"), params: ThreadCreateParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/get"), params: z.object({ threadId: ThreadIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/rename"), params: ThreadRenameParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/archive"), params: z.object({ threadId: ThreadIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("thread/unarchive"), params: z.object({ threadId: ThreadIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/catalog"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/models"), params: z.object({ providerId: ProviderIdSchema }).strict() }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/current"), params: EmptyParamsSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/select"), params: ProviderSelectionSchema }).strict(),
  z.object({ ...AppServerRequestShape, method: z.literal("provider/clear"), params: EmptyParamsSchema }).strict(),
]);
export type AppServerRequest = z.infer<typeof AppServerRequestSchema>;
export type AppServerMethod = z.infer<typeof AppServerMethodSchema>;

export const AppServerResultSchemas = {
  "session/history": ConversationHistoryResponseSchema,
  initialize: AppServerInitializeResponseSchema,
  "workspace/current": LocalWorkspaceGrantResponseSchema,
  "workspace/grant": LocalWorkspaceGrantResponseSchema,
  "workspace/revoke": z.object({ revoked: z.literal(true) }).strict(),
  "thread/list": z.object({ threads: z.array(ThreadSchema) }).strict(),
  "thread/create": z.object({ thread: ThreadSchema }).strict(),
  "thread/get": z.object({ thread: ThreadSchema }).strict(),
  "thread/rename": z.object({ thread: ThreadSchema }).strict(),
  "thread/archive": z.object({ thread: ThreadSchema }).strict(),
  "thread/unarchive": z.object({ thread: ThreadSchema }).strict(),
  "provider/catalog": z.object({ providers: ProviderRegistryEntrySchema.array() }).strict(),
  "provider/models": BYOKDiscoveredProviderModelsResponseSchema,
  "provider/current": z.object({ selection: ProviderSelectionSchema.nullable() }).strict(),
  "provider/select": z.object({ selection: ProviderSelectionSchema }).strict(),
  "provider/clear": z.object({ selection: z.null() }).strict(),
} as const;

export const AppServerSuccessResponseSchema = z.discriminatedUnion("method", [
  success("session/history", AppServerResultSchemas["session/history"]),
  success("initialize", AppServerResultSchemas.initialize),
  success("workspace/current", AppServerResultSchemas["workspace/current"]),
  success("workspace/grant", AppServerResultSchemas["workspace/grant"]),
  success("workspace/revoke", AppServerResultSchemas["workspace/revoke"]),
  success("thread/list", AppServerResultSchemas["thread/list"]),
  success("thread/create", AppServerResultSchemas["thread/create"]),
  success("thread/get", AppServerResultSchemas["thread/get"]),
  success("thread/rename", AppServerResultSchemas["thread/rename"]),
  success("thread/archive", AppServerResultSchemas["thread/archive"]),
  success("thread/unarchive", AppServerResultSchemas["thread/unarchive"]),
  success("provider/catalog", AppServerResultSchemas["provider/catalog"]),
  success("provider/models", AppServerResultSchemas["provider/models"]),
  success("provider/current", AppServerResultSchemas["provider/current"]),
  success("provider/select", AppServerResultSchemas["provider/select"]),
  success("provider/clear", AppServerResultSchemas["provider/clear"]),
]);

export const AppServerFailureResponseSchema = z
  .object({
    protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
    method: AppServerMethodSchema,
    ok: z.literal(false),
    error: AppServerErrorSchema,
  })
  .strict();

export const AppServerResponseSchema = z.union([
  AppServerSuccessResponseSchema,
  AppServerFailureResponseSchema,
]);
export type AppServerResponse = z.infer<typeof AppServerResponseSchema>;
export type AppServerSuccessResponse = z.infer<
  typeof AppServerSuccessResponseSchema
>;
export type AppServerFailureResponse = z.infer<
  typeof AppServerFailureResponseSchema
>;

function success<
  const Method extends AppServerMethod,
  Schema extends z.ZodTypeAny,
>(
  method: Method,
  result: Schema,
) {
  return z
    .object({
      protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION),
      method: z.literal(method),
      ok: z.literal(true),
      result,
    })
    .strict();
}
