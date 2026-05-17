CREATE INDEX "artifacts_run_user_status_updated_idx" ON "artifacts" USING btree ("run_id","user_id","status","updated_at");
