import { z } from "zod";

export const CodeArtifactContentRequestSchema = z.object({
  sessionId: z.string().uuid(),
  key: z.string().min(1).max(4_096),
}).strict();

export const CodeArtifactContentResponseSchema = z.object({
  content: z.string(),
}).strict();

export type CodeArtifactContentRequest = z.infer<typeof CodeArtifactContentRequestSchema>;
export type CodeArtifactContentResponse = z.infer<typeof CodeArtifactContentResponseSchema>;
