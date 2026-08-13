ALTER TABLE "ori_metrics" ADD COLUMN "disk_used_bytes" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ori_metrics" ADD COLUMN "disk_total_bytes" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ori_metrics" ADD COLUMN "io_percent" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ori_metrics" ADD COLUMN "top_processes" jsonb;