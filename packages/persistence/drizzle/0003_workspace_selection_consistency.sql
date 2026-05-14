CREATE UNIQUE INDEX "workspaces_id_repo_idx" ON "workspaces" USING btree ("id","repo_id");--> statement-breakpoint
ALTER TABLE "workspace_selections" ADD CONSTRAINT "workspace_selections_workspace_repo_fk" FOREIGN KEY ("selected_workspace_id","selected_repo_id") REFERENCES "public"."workspaces"("id","repo_id") ON DELETE cascade ON UPDATE no action;
