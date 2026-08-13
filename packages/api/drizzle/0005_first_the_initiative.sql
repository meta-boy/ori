CREATE INDEX "oris_user_created_idx" ON "oris" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "oris_state_idx" ON "oris" USING btree ("state");--> statement-breakpoint
CREATE INDEX "snapshots_ori_status_created_idx" ON "snapshots" USING btree ("ori_id","status","created_at" desc);--> statement-breakpoint
CREATE INDEX "starts_log_created_idx" ON "starts_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_ledger_ori_to_idx" ON "usage_ledger" USING btree ("ori_id","to_ts" desc);--> statement-breakpoint
CREATE INDEX "usage_ledger_user_idx" ON "usage_ledger" USING btree ("user_id");