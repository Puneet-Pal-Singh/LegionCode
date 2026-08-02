CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_id_user_id_idx" ON "workspaces" ("id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hook_definitions" (
  "user_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "handler_id" text NOT NULL,
  "event_name" text NOT NULL,
  "source" text NOT NULL,
  "display_name" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "hook_order" integer NOT NULL,
  "timeout_ms" integer NOT NULL,
  "configuration_key" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hook_definitions_pk" PRIMARY KEY("user_id", "workspace_id", "handler_id"),
  CONSTRAINT "hook_definitions_workspace_owner_fk" FOREIGN KEY ("workspace_id", "user_id") REFERENCES "workspaces"("id", "user_id") ON DELETE CASCADE,
  CONSTRAINT "hook_definitions_handler_id_length_check" CHECK (char_length("handler_id") BETWEEN 1 AND 128),
  CONSTRAINT "hook_definitions_display_name_length_check" CHECK (char_length("display_name") BETWEEN 1 AND 120),
  CONSTRAINT "hook_definitions_event_name_check" CHECK ("event_name" IN ('SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop')),
  CONSTRAINT "hook_definitions_source_check" CHECK ("source" IN ('user', 'project', 'plugin')),
  CONSTRAINT "hook_definitions_order_check" CHECK ("hook_order" BETWEEN 0 AND 10000),
  CONSTRAINT "hook_definitions_timeout_check" CHECK ("timeout_ms" BETWEEN 50 AND 30000),
  CONSTRAINT "hook_definitions_configuration_key_length_check" CHECK ("configuration_key" IS NULL OR char_length("configuration_key") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hook_definitions_workspace_updated_at_idx" ON "hook_definitions" ("user_id", "workspace_id", "updated_at" DESC);
