import { z } from "zod";

export const ProtocolTimestampSchema = z.string().datetime({
  offset: true,
});
export type ProtocolTimestamp = z.infer<typeof ProtocolTimestampSchema>;

export const EventSequenceSchema = z.number().int().safe().nonnegative();
export type EventSequence = z.infer<typeof EventSequenceSchema>;

export const BranchIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export type BranchId = z.infer<typeof BranchIdSchema>;
