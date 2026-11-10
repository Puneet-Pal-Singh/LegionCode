import { z } from "zod";

/** Exact display facts from an already validated tool call, never an authorization input.
 * Tool schemas retain their existing size/byte/path limits; consent is not truncated.
 */
export const ApprovalExecutionPresentationSchema = z.object({
  kind: z.literal("executable"),
  title: z.string().min(1),
  executable: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
}).strict();

export type ApprovalExecutionPresentation = z.infer<typeof ApprovalExecutionPresentationSchema>;
