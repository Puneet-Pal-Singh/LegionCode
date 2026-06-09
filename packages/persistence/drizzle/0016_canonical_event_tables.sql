CREATE TABLE IF NOT EXISTS "canonical_event_scope_sequences" (
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_event_scope_sequences_pk" PRIMARY KEY("scope_type","scope_id"),
	CONSTRAINT "canonical_event_scope_sequences_scope_type_check" CHECK (scope_type IN ('thread', 'run', 'workspace', 'artifact', 'provider')),
	CONSTRAINT "canonical_event_scope_sequences_next_sequence_check" CHECK ("canonical_event_scope_sequences"."next_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canonical_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text,
	"workspace_id" text NOT NULL,
	"artifact_id" text,
	"provider_id" text,
	"sequence" bigint NOT NULL,
	"global_sequence" bigserial NOT NULL,
	"cursor" text NOT NULL,
	"idempotency_key" text,
	"event_type" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"schema_version" integer NOT NULL,
	"producer_kind" text NOT NULL,
	"producer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_events_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "canonical_events_cursor_unique" UNIQUE("cursor"),
	CONSTRAINT "canonical_events_scope_sequence_unique" UNIQUE("scope_type","scope_id","sequence"),
	CONSTRAINT "canonical_events_scope_type_check" CHECK (scope_type IN ('thread', 'run', 'workspace', 'artifact', 'provider')),
	CONSTRAINT "canonical_events_sequence_check" CHECK ("canonical_events"."sequence" > 0),
	CONSTRAINT "canonical_events_schema_version_check" CHECK ("canonical_events"."schema_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "canonical_events_scope_idempotency_idx" ON "canonical_events" USING btree ("scope_type","scope_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_events_scope_sequence_idx" ON "canonical_events" USING btree ("scope_type","scope_id","sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_events_thread_sequence_idx" ON "canonical_events" USING btree ("thread_id","global_sequence");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canonical_events_workspace_sequence_idx" ON "canonical_events" USING btree ("workspace_id","global_sequence");
