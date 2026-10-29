import { z } from "zod";

export const RepositoryReadOwnerSchema = z
  .object({
    login: z.string(),
    avatar_url: z.string(),
  })
  .passthrough();

export const RepositoryReadRepositorySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    full_name: z.string(),
    owner: RepositoryReadOwnerSchema,
    description: z.string().nullable(),
    private: z.boolean(),
    html_url: z.string(),
    clone_url: z.string(),
    default_branch: z.string(),
    stargazers_count: z.number().int(),
    language: z.string().nullable(),
    updated_at: z.string(),
  })
  .passthrough();

export const RepositoryReadBranchSchema = z
  .object({
    name: z.string(),
    commit: z
      .object({
        sha: z.string(),
        url: z.string(),
      })
      .passthrough(),
    protected: z.boolean(),
  })
  .passthrough();

export const RepositoryReadTreeEntrySchema = z
  .object({
    path: z.string(),
    type: z.string(),
    sha: z.string(),
  })
  .passthrough();

export const RepositoryReadContentsSchema = z
  .object({
    content: z.string().optional(),
    sha: z.string(),
    size: z.number().int().nonnegative(),
    encoding: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    type: z.enum(["file", "dir"]).optional(),
    html_url: z.string().optional(),
    download_url: z.string().nullable().optional(),
  })
  .passthrough();

export const RepositoryContentsResponseSchema = z.union([
  RepositoryReadContentsSchema,
  z.array(RepositoryReadContentsSchema),
]);

export const RepositoryListRequestSchema = z
  .object({
    type: z.enum(["all", "owner", "member"]).optional(),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional(),
  })
  .strict();

export const RepositoryBranchesRequestSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
  })
  .strict();

export const RepositoryTreeRequestSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    sha: z.string().min(1).optional(),
  })
  .strict();

export const RepositoryContentsRequestSchema = z
  .object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().optional(),
    ref: z.string().optional(),
  })
  .strict();

export const RepositoryListResponseSchema = z.array(
  RepositoryReadRepositorySchema,
);
export const RepositoryBranchesResponseSchema = z.array(
  RepositoryReadBranchSchema,
);
export const RepositoryTreeResponseSchema = z.array(
  RepositoryReadTreeEntrySchema,
);

export type RepositoryReadRepository = z.infer<
  typeof RepositoryReadRepositorySchema
>;
export type RepositoryReadBranch = z.infer<typeof RepositoryReadBranchSchema>;
export type RepositoryReadTreeEntry = z.infer<
  typeof RepositoryReadTreeEntrySchema
>;
export type RepositoryReadContents = z.infer<
  typeof RepositoryReadContentsSchema
>;
export type RepositoryContentsResponse = z.infer<
  typeof RepositoryContentsResponseSchema
>;
export type RepositoryListRequest = z.infer<typeof RepositoryListRequestSchema>;
export type RepositoryBranchesRequest = z.infer<
  typeof RepositoryBranchesRequestSchema
>;
export type RepositoryTreeRequest = z.infer<typeof RepositoryTreeRequestSchema>;
export type RepositoryContentsRequest = z.infer<
  typeof RepositoryContentsRequestSchema
>;
export type RepositoryListResponse = z.infer<
  typeof RepositoryListResponseSchema
>;
export type RepositoryBranchesResponse = z.infer<
  typeof RepositoryBranchesResponseSchema
>;
export type RepositoryTreeResponse = z.infer<
  typeof RepositoryTreeResponseSchema
>;
