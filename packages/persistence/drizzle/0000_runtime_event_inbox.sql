CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_event_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error_message" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "runtime_event_inbox_status_check" CHECK ("runtime_event_inbox"."status" IN ('received', 'processing', 'processed', 'failed')),
	CONSTRAINT "runtime_event_inbox_payload_schema_version_check" CHECK ("runtime_event_inbox"."payload_schema_version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runtime_event_inbox_source_idempotency_key_idx" ON "runtime_event_inbox" USING btree ("source","idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_event_inbox_status_received_at_idx" ON "runtime_event_inbox" USING btree ("status","received_at");
