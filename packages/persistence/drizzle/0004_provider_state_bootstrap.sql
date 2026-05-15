CREATE TABLE "provider_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_id" text,
	"credential_id" uuid,
	"operation" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"metadata_json" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_audit_events_type_check" CHECK ("provider_audit_events"."operation" IN ('connect', 'validate', 'disconnect', 'preferences', 'resolution_failure')),
	CONSTRAINT "provider_audit_events_status_check" CHECK ("provider_audit_events"."status" IN ('success', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "provider_axis_quota" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"day_key" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_axis_quota_usage_count_check" CHECK ("provider_axis_quota"."usage_count" >= 0),
	CONSTRAINT "provider_axis_quota_user_workspace_day_pk" PRIMARY KEY("user_id","workspace_id","day_key")
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"encrypted_secret_json" jsonb NOT NULL,
	"key_version" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "provider_credentials_status_check" CHECK ("provider_credentials"."status" IN ('connected', 'failed', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "provider_preferences" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"default_provider_id" text,
	"default_credential_id" uuid,
	"default_model_id" text,
	"fallback_mode" text DEFAULT 'strict' NOT NULL,
	"fallback_json" jsonb,
	"visible_model_ids_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_labels_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_preferences_user_workspace_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "provider_registry_cache" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"auth_modes_json" jsonb NOT NULL,
	"capabilities_json" jsonb NOT NULL,
	"models_json" jsonb NOT NULL,
	"source_version" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"refreshed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_user_model_cache" (
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"models_json" jsonb NOT NULL,
	"source_version" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "provider_user_model_cache_user_provider_credential_pk" PRIMARY KEY("user_id","provider_id","credential_id")
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_preferences" ADD CONSTRAINT "provider_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_preferences" ADD CONSTRAINT "provider_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_axis_quota" ADD CONSTRAINT "provider_axis_quota_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_axis_quota" ADD CONSTRAINT "provider_axis_quota_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" ADD CONSTRAINT "provider_user_model_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_user_model_cache" ADD CONSTRAINT "provider_user_model_cache_credential_id_provider_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_audit_events_scope_time_idx" ON "provider_audit_events" USING btree ("user_id","workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_audit_events_type_time_idx" ON "provider_audit_events" USING btree ("operation","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_axis_quota_updated_at_idx" ON "provider_axis_quota" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_user_provider_idx" ON "provider_credentials" USING btree ("user_id","provider_id") WHERE "provider_credentials"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "provider_credentials_user_status_idx" ON "provider_credentials" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "provider_credentials_created_at_idx" ON "provider_credentials" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_user_model_cache_expiry_idx" ON "provider_user_model_cache" USING btree ("expires_at");
