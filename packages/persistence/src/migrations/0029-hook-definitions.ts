import type { SqlMigration } from "./types.js";

/**
 * Stores Brain-owned hook configuration only. Runtime invocation truth remains
 * in the canonical lifecycle event store.
 *
 * The composite workspace foreign key prevents a user-scoped definition from
 * being attached to another user's workspace even if a caller bypasses Brain.
 */
export const hookDefinitionsMigration: SqlMigration = {
  id: "0029_hook_definitions",
  description: "Create user-scoped workspace hook definition storage",
  statements: [
    `
      CREATE UNIQUE INDEX IF NOT EXISTS workspaces_id_user_id_idx
        ON workspaces (id, user_id)
    `,
    `
      CREATE TABLE IF NOT EXISTS hook_definitions (
        user_id UUID NOT NULL,
        workspace_id UUID NOT NULL,
        handler_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        source TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        hook_order INTEGER NOT NULL,
        timeout_ms INTEGER NOT NULL,
        configuration_key TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT hook_definitions_pk
          PRIMARY KEY (user_id, workspace_id, handler_id),
        CONSTRAINT hook_definitions_workspace_owner_fk
          FOREIGN KEY (workspace_id, user_id)
          REFERENCES workspaces (id, user_id)
          ON DELETE CASCADE,
        CONSTRAINT hook_definitions_handler_id_length_check
          CHECK (char_length(handler_id) BETWEEN 1 AND 128),
        CONSTRAINT hook_definitions_display_name_length_check
          CHECK (char_length(display_name) BETWEEN 1 AND 120),
        CONSTRAINT hook_definitions_event_name_check
          CHECK (
            event_name IN (
              'SessionStart',
              'UserPromptSubmit',
              'PermissionRequest',
              'Stop'
            )
          ),
        CONSTRAINT hook_definitions_source_check
          CHECK (source IN ('user', 'project', 'plugin')),
        CONSTRAINT hook_definitions_order_check
          CHECK (hook_order BETWEEN 0 AND 10000),
        CONSTRAINT hook_definitions_timeout_check
          CHECK (timeout_ms BETWEEN 50 AND 30000),
        CONSTRAINT hook_definitions_configuration_key_length_check
          CHECK (
            configuration_key IS NULL OR
            char_length(configuration_key) BETWEEN 1 AND 256
          )
      )
    `,
    `
      CREATE INDEX IF NOT EXISTS hook_definitions_workspace_updated_at_idx
        ON hook_definitions (user_id, workspace_id, updated_at DESC)
    `,
  ],
};
