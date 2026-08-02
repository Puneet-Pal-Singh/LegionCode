/**
 * BYOK Resolution Result
 *
 * Represents the resolved effective provider + model for a chat request.
 * Result of the resolution pipeline (request override → preference → explicit defaults/error).
 */

import { z } from "zod";

/**
 * BYOKResolution - Resolved effective provider + model for a chat request
 *
 * This is the result of the resolution pipeline:
 * 1. Request override
 * 2. Session preference
 * 3. Workspace preference
 * 4. Platform defaults (explicit, not fallback) - RCP3 change
 *
 * credentialId is always a concrete credential identity (virtual UUID for
 * platform-managed providers, persisted UUID for BYOK credentials).
 */
export const BYOKResolutionSchema = z.object({
  /** Resolved provider ID */
  providerId: z.string().min(1),

  /** Resolved credential ID */
  credentialId: z.string().uuid(),

  /** Resolved model ID */
  modelId: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),

  /** Which resolution step was used */
  resolvedAt: z.enum([
    "request_override",
    "session_preference",
    "workspace_preference",
    "platform_defaults",
  ]),

  /** Timestamp of resolution */
  resolvedAtTime: z.string().datetime(),

  /** Optional provider quota metadata for UI surfaces */
  quota: z
    .object({
      used: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      resetsAt: z.string().datetime(),
    })
    .optional(),
});

export type BYOKResolution = z.infer<typeof BYOKResolutionSchema>;

/**
 * BYOKResolveRequest - Request to resolve effective provider config
 *
 * Used in chat flow to determine which provider+key+model to use.
 */
export const BYOKResolveRequestSchema = z.object({
  /** Override provider (optional) */
  providerId: z.string().optional(),

  /** Override credential (optional) */
  credentialId: z.string().uuid().optional(),

  /** Override model (optional) */
  modelId: z.string().optional(),

  /** Session ID (for preference lookup) */
  sessionId: z.string().optional(),
});

export type BYOKResolveRequest = z.infer<typeof BYOKResolveRequestSchema>;
