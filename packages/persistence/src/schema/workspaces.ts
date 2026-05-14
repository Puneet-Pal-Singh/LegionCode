import { sql } from "drizzle-orm";
import {
  index,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./identity.js";

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull(),
    providerRepoId: text("provider_repo_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("repos_provider_owner_name_idx").on(
      table.provider,
      table.owner,
      table.name,
    ),
  ],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    lastSelectedBranch: text("last_selected_branch").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lastOpenedAt: timestamp("last_opened_at", {
      withTimezone: true,
      mode: "string",
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspaces_user_repo_idx").on(table.userId, table.repoId),
    index("workspaces_user_updated_at_idx").on(table.userId, table.updatedAt),
    index("workspaces_repo_id_idx").on(table.repoId),
    check(
      "workspaces_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export const workspaceSelections = pgTable(
  "workspace_selections",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    selectedWorkspaceId: uuid("selected_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    selectedRepoId: uuid("selected_repo_id")
      .notNull()
      .references(() => repos.id),
    selectedBranch: text("selected_branch").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId],
      name: "workspace_selections_user_id_pk",
    }),
    index("workspace_selections_workspace_id_idx").on(
      table.selectedWorkspaceId,
    ),
    index("workspace_selections_repo_id_idx").on(table.selectedRepoId),
  ],
);
