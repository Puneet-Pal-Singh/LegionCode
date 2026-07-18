import { z } from "zod";
import { PrivateAlphaHookEventNameSchema } from "./events.js";

export const HookHandlerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]{0,127}$/);
export type HookHandlerId = z.infer<typeof HookHandlerIdSchema>;

export const HookSourceSchema = z.enum(["user", "project", "plugin"]);
export type HookSource = z.infer<typeof HookSourceSchema>;

/**
 * A declarative hook registration. The configuration key is an opaque lookup
 * key owned by the server; it is deliberately not an arbitrary URL or path.
 */
export const HookDefinitionSchema = z
  .object({
    handlerId: HookHandlerIdSchema,
    eventName: PrivateAlphaHookEventNameSchema,
    source: HookSourceSchema,
    displayName: z.string().trim().min(1).max(120),
    enabled: z.boolean(),
    order: z.number().int().min(0).max(10_000),
    timeoutMs: z.number().int().min(50).max(30_000),
    configurationKey: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/)
      .nullable(),
  })
  .strict();
export type HookDefinition = z.infer<typeof HookDefinitionSchema>;
