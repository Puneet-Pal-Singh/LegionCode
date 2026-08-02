/**
 * Provider schemas used by Brain runtime boundaries.
 *
 * Transport contracts are canonical in @repo/shared-types.
 * This module only composes local runtime-only schemas.
 */

import { z } from "zod";
import {
  BYOKConnectRequestSchema,
  BYOKConnectResponseSchema,
  BYOKDisconnectRequestSchema,
  BYOKDisconnectResponseSchema,
  ModelDescriptorSchema,
  ProviderConnectionSchema,
  ProviderIdSchema,
  type BYOKConnectRequest,
  type BYOKConnectResponse,
  type BYOKDisconnectRequest,
  type BYOKDisconnectResponse,
  type ModelDescriptor,
  type ProviderConnection,
  type ProviderId,
} from "@repo/shared-types";

export {
  ProviderIdSchema,
  BYOKConnectRequestSchema as ConnectProviderRequestSchema,
  BYOKConnectResponseSchema as ConnectProviderResponseSchema,
  BYOKDisconnectRequestSchema as DisconnectProviderRequestSchema,
  BYOKDisconnectResponseSchema as DisconnectProviderResponseSchema,
  ModelDescriptorSchema,
  ProviderConnectionSchema as ProviderConnectionStatusSchema,
};
export type {
  ProviderId,
  BYOKConnectRequest as ConnectProviderRequest,
  BYOKConnectResponse as ConnectProviderResponse,
  BYOKDisconnectRequest as DisconnectProviderRequest,
  BYOKDisconnectResponse as DisconnectProviderResponse,
  ModelDescriptor,
  ProviderConnection as ProviderConnectionStatus,
};

export const ProviderStatusResponseSchema = z.object({
  providers: z.array(ProviderConnectionSchema),
});
export type ProviderStatusResponse = z.infer<
  typeof ProviderStatusResponseSchema
>;

/**
 * Schema for validating provider/model selection in chat requests.
 * If either providerId or modelId is provided, both must be provided.
 */
export const ChatProviderSelectionSchema = z
  .object({
    providerId: ProviderIdSchema.optional(),
    modelId: z.string().optional(),
  })
  .refine(
    (data) =>
      !(
        (data.providerId && !data.modelId) ||
        (!data.providerId && data.modelId)
      ),
    {
      message:
        "providerId and modelId must be provided together or both omitted",
      path: ["providerId"],
    },
  );
export type ChatProviderSelection = z.infer<typeof ChatProviderSelectionSchema>;
