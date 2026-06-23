import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { WorkerExecutionLocationSchema } from "@repo/platform-protocol";
import { WorkspaceStateSchema } from "@repo/workspace-core";
import { buildSqlList } from "../sessions/types.js";

const WORKSPACE_MANIFEST_STATE_SQL_LIST = buildSqlList(
  WorkspaceStateSchema.options,
);
const WORKER_EXECUTION_LOCATION_SQL_LIST = buildSqlList(
  WorkerExecutionLocationSchema.options,
);

export const workspaceManifests = pgTable(
  "workspace_manifests",
  {
    workspaceId: text("workspace_id").primaryKey(),
    runId: text("run_id").notNull(),
    workerId: text("worker_id").notNull(),
    permissionProfileId: text("permission_profile_id").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    repoUrl: text("repo_url").notNull(),
    baseBranch: text("base_branch").notNull(),
    workingBranch: text("working_branch").notNull(),
    baseSha: text("base_sha").notNull(),
    headSha: text("head_sha").notNull(),
    executionLocation: text("execution_location").notNull(),
    filesystemRoot: text("filesystem_root").notNull(),
    artifactNamespace: text("artifact_namespace").notNull(),
    state: text("state").notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table) => [
    index("workspace_manifests_run_updated_idx").on(
      table.runId,
      table.updatedAt,
    ),
    index("workspace_manifests_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    check(
      "workspace_manifests_state_check",
      sql`${table.state} IN (${sql.raw(WORKSPACE_MANIFEST_STATE_SQL_LIST)})`,
    ),
    check(
      "workspace_manifests_execution_location_check",
      sql`${table.executionLocation} IN (${sql.raw(WORKER_EXECUTION_LOCATION_SQL_LIST)})`,
    ),
  ],
);
