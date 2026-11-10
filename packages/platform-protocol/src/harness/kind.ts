import { z } from "zod";
export const HarnessKindSchema = z.enum(["codex", "claude", "opencode"]);
export type HarnessKind = z.infer<typeof HarnessKindSchema>;
