import { z } from "zod";
import {
  InterruptTurnIdentitySchema,
  InterruptTurnRequestSchema,
  type InterruptTurnRequest,
} from "@repo/platform-protocol";

export const BrainWorkspaceIdSchema = z.string().uuid();

export const RunInterruptIdentitySchema = InterruptTurnIdentitySchema;
export const RunInterruptRequestSchema = InterruptTurnRequestSchema;

export type RunInterruptIdentity = z.infer<typeof RunInterruptIdentitySchema>;
export type RunInterruptRequest = InterruptTurnRequest;
