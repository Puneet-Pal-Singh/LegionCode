CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" text NOT NULL,
	"provider_repo_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_selections" (
	"user_id" uuid NOT NULL,
	"selected_workspace_id" uuid NOT NULL,
	"selected_repo_id" uuid NOT NULL,
	"selected_branch" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_selections_user_id_pk" PRIMARY KEY("user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_branch" text NOT NULL,
	"last_selected_branch" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_status_check" CHECK ("workspaces"."status" IN ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "workspace_selections" ADD CONSTRAINT "workspace_selections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_selections" ADD CONSTRAINT "workspace_selections_selected_workspace_id_workspaces_id_fk" FOREIGN KEY ("selected_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_selections" ADD CONSTRAINT "workspace_selections_selected_repo_id_repos_id_fk" FOREIGN KEY ("selected_repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_provider_owner_name_idx" ON "repos" USING btree ("provider","owner","name");--> statement-breakpoint
CREATE INDEX "workspace_selections_workspace_id_idx" ON "workspace_selections" USING btree ("selected_workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_selections_repo_id_idx" ON "workspace_selections" USING btree ("selected_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_user_repo_idx" ON "workspaces" USING btree ("user_id","repo_id");--> statement-breakpoint
CREATE INDEX "workspaces_user_updated_at_idx" ON "workspaces" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "workspaces_repo_id_idx" ON "workspaces" USING btree ("repo_id");
