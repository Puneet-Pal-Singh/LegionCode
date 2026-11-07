import { z } from "zod";
import { ArtifactIdSchema, TurnIdSchema } from "./ids.js";
import { GitObjectIdSchema } from "./task-workspaces.js";

/** Selects the one published immutable diff of an authorized settled Turn.
 * Workspace, attempt, artifact identity and paths remain server-derived. */
export const CommitTurnArtifactRequestSchema = z
  .object({
    turnId: TurnIdSchema,
    message: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .regex(/^[^\0\r\n]+$/u),
    author: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .regex(/^[^\0\r\n]+$/u),
        email: z.string().email().max(320),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CommitTurnArtifactRequest = z.infer<
  typeof CommitTurnArtifactRequestSchema
>;

/** The actual committed source and Git receipt, never a fabricated success. */
export const CommitTurnArtifactResponseSchema = z
  .object({
    turnId: TurnIdSchema,
    artifactId: ArtifactIdSchema,
    commitSha: GitObjectIdSchema,
    branchName: z
      .string()
      .min(1)
      .max(1_024)
      .regex(/^[^\0\r\n]+$/u),
  })
  .strict();
export type CommitTurnArtifactResponse = z.infer<
  typeof CommitTurnArtifactResponseSchema
>;
