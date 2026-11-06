import { z } from "zod";

export const ChatRunModeSchema = z.enum(["build", "plan"]);
export type ChatRunMode = z.infer<typeof ChatRunModeSchema>;
