import { z } from "zod";
import { ModelIdSchema, ThreadIdSchema } from "../ids.js";
import { WorkspaceScopeIdSchema } from "../turn-scope-bootstrap.js";
import { HarnessCapabilitiesSchema, HarnessKindSchema } from "./index.js";

const Reference = z.string().trim().min(1).max(256);
const Revision = z.number().int().safe().nonnegative();

/** Product workspace scope, shared with turn reservation; never a filesystem root. */
export const HarnessScopeSchema = z.object({
  workspaceId: WorkspaceScopeIdSchema,
  environmentId: Reference,
}).strict();
export const HarnessInstanceScopeSchema = HarnessScopeSchema.extend({ instanceId: Reference }).strict();
export const HarnessSetupRequestSchema = HarnessInstanceScopeSchema.extend({
  harness: HarnessKindSchema,
  connectionId: Reference,
  clientCommandId: Reference,
}).strict();
export const HarnessStatusRequestSchema = HarnessScopeSchema;
export const HarnessModelsRequestSchema = HarnessInstanceScopeSchema.extend({ connectionId: Reference }).strict();
export const HarnessSelectionReadRequestSchema = HarnessScopeSchema.extend({
  sessionId: Reference,
  threadId: ThreadIdSchema,
}).strict();

/** Configuration for a future attempt, never a mutation of an admitted binding.
 * The service validates account/model eligibility and resolves policy/runtime pins
 * at admission. External session IDs and secret material never enter this type.
 */
export const HarnessNextSelectionSchema = z.object({
  harness: HarnessKindSchema,
  instanceId: Reference,
  connectionId: Reference,
  modelId: ModelIdSchema,
}).strict();
export const HarnessSelectRequestSchema = HarnessSelectionReadRequestSchema.extend({
  clientCommandId: Reference,
  expectedRevision: Revision,
  selection: HarnessNextSelectionSchema.nullable(),
}).strict();

export const HarnessInstanceStatusSchema = HarnessInstanceScopeSchema.extend({
  harness: HarnessKindSchema,
  connectionId: Reference.nullable(),
  accountLabel: z.string().min(1).max(256).nullable(),
  state: z.enum(["ready", "offline", "connecting", "reauthentication_required", "unavailable"]),
  reason: z.string().max(2000).nullable(),
  capabilities: HarnessCapabilitiesSchema,
  runtimeVersion: Reference.nullable(),
  protocolVersion: Reference.nullable(),
  observedAt: z.string().datetime(),
}).strict();
export const HarnessStatusResponseSchema = z.object({ instances: z.array(HarnessInstanceStatusSchema).max(200) }).strict();
export const HarnessSetupResponseSchema = z.object({ instance: HarnessInstanceStatusSchema }).strict();
export const HarnessModelsResponseSchema = HarnessModelsRequestSchema.extend({
  models: z.array(z.object({ id: ModelIdSchema, label: z.string().min(1).max(256) }).strict()).max(2000),
  availability: z.enum(["available", "unavailable"]),
  reason: z.string().max(2000).nullable(),
  observedAt: z.string().datetime(),
}).strict();
export const HarnessSelectionResponseSchema = HarnessSelectionReadRequestSchema.extend({
  revision: Revision,
  selection: HarnessNextSelectionSchema.nullable(),
}).strict();

export type HarnessSetupRequest = z.infer<typeof HarnessSetupRequestSchema>;
export type HarnessSetupResponse = z.infer<typeof HarnessSetupResponseSchema>;
export type HarnessStatusRequest = z.infer<typeof HarnessStatusRequestSchema>;
export type HarnessStatusResponse = z.infer<typeof HarnessStatusResponseSchema>;
export type HarnessModelsRequest = z.infer<typeof HarnessModelsRequestSchema>;
export type HarnessModelsResponse = z.infer<typeof HarnessModelsResponseSchema>;
export type HarnessSelectionReadRequest = z.infer<typeof HarnessSelectionReadRequestSchema>;
export type HarnessSelectRequest = z.infer<typeof HarnessSelectRequestSchema>;
export type HarnessSelectionResponse = z.infer<typeof HarnessSelectionResponseSchema>;
export type HarnessNextSelection = z.infer<typeof HarnessNextSelectionSchema>;
export type HarnessInstanceStatus = z.infer<typeof HarnessInstanceStatusSchema>;
