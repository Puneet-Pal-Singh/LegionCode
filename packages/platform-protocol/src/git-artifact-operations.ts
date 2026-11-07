import { z } from "zod";
import { ArtifactIdSchema, TurnIdSchema } from "./ids.js";
import { GitObjectIdSchema } from "./task-workspaces.js";

const SavedPathSchema = z.string().min(1).max(2_048).refine((path) =>
  !path.startsWith("/") &&
  !/^[A-Za-z]:/u.test(path) &&
  !path.includes("\\") &&
  !/[\u0000-\u001f\u007f]/u.test(path) &&
  !path.split("/").some((segment) =>
    !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git",
  ), "Saved selection must contain repository-relative file paths");

export const TurnArtifactCommitSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({
    kind: z.literal("paths"),
    paths: z.array(SavedPathSchema).min(1).max(2_000).refine(
      (paths) => new Set(paths).size === paths.length,
      "Saved selection cannot contain duplicate paths",
    ),
  }).strict(),
]);
export type TurnArtifactCommitSelection = z.infer<typeof TurnArtifactCommitSelectionSchema>;

/** Selects the one published immutable diff of an authorized settled Turn.
 * Requested paths select saved file entries, never current filesystem content.
 * Workspace, attempt, artifact identity and rename path pairs are server-derived. */
export const CommitTurnArtifactRequestSchema = z
  .object({
    turnId: TurnIdSchema,
    selection: TurnArtifactCommitSelectionSchema,
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
