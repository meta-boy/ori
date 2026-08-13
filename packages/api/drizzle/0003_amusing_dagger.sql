CREATE TABLE "ori_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ori_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_percent" double precision DEFAULT 0 NOT NULL,
	"mem_bytes" double precision DEFAULT 0 NOT NULL,
	"mem_limit_bytes" double precision DEFAULT 0 NOT NULL,
	"block_io_bytes" double precision DEFAULT 0 NOT NULL,
	"net_io_bytes" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ori_metrics" ADD CONSTRAINT "ori_metrics_ori_id_oris_id_fk" FOREIGN KEY ("ori_id") REFERENCES "public"."oris"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ori_metrics_ori_at_idx" ON "ori_metrics" USING btree ("ori_id","at");