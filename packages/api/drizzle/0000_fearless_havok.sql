CREATE TABLE "account_secrets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"env_contents" text,
	"secret_files" jsonb
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_last_four" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ori_env" (
	"ori_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "ori_env_ori_id_key_pk" PRIMARY KEY("ori_id","key")
);
--> statement-breakpoint
CREATE TABLE "ori_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"ori_id" text NOT NULL,
	"id" text,
	"type" text NOT NULL,
	"timestamp" bigint NOT NULL,
	"task_id" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "oris" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'init' NOT NULL,
	"type" text DEFAULT 'default' NOT NULL,
	"host_id" text,
	"machine_id" text,
	"ip" text,
	"subdomain" text,
	"no_env" boolean DEFAULT false NOT NULL,
	"machine_token_hash" text,
	"agent_token_hash" text,
	"ttl_seconds" integer,
	"archive_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"desktop_available" boolean DEFAULT false NOT NULL,
	"desktop_token" text,
	"desktop_expires_at" timestamp with time zone,
	"snapshot_available" boolean DEFAULT false NOT NULL,
	"snapshot_completed_at" timestamp with time zone,
	"last_snapshot_attempt_at" timestamp with time zone,
	"last_snapshot_status" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"driver" text NOT NULL,
	"capacity_vcpu" integer NOT NULL,
	"capacity_mem_gb" integer NOT NULL,
	"ip" text,
	"status" text DEFAULT 'ready' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "port_routes" (
	"ori_id" text NOT NULL,
	"port" integer NOT NULL,
	"subdomain" text NOT NULL,
	"title" text,
	"public" boolean DEFAULT false NOT NULL,
	"token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "port_routes_ori_id_port_pk" PRIMARY KEY("ori_id","port")
);
--> statement-breakpoint
CREATE TABLE "prompt_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"prompt_id" text NOT NULL,
	"ori_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider" text,
	"model" text,
	"reasoning_effort" text,
	"prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshot_chunks" (
	"snapshot_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"r2_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "snapshot_chunks_snapshot_id_chunk_index_pk" PRIMARY KEY("snapshot_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ori_id" text NOT NULL,
	"chain_id" uuid,
	"generation" integer DEFAULT 0 NOT NULL,
	"kind" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"content_size_bytes" bigint,
	"content_file_count" integer,
	"restic_id" text
);
--> statement-breakpoint
CREATE TABLE "starts_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"ori_id" text,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ori_id" text,
	"user_id" text NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"seconds" integer DEFAULT 0 NOT NULL,
	"multiplier" integer DEFAULT 1 NOT NULL,
	"machine_seconds" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_secrets" ADD CONSTRAINT "account_secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ori_env" ADD CONSTRAINT "ori_env_ori_id_oris_id_fk" FOREIGN KEY ("ori_id") REFERENCES "public"."oris"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ori_events" ADD CONSTRAINT "ori_events_ori_id_oris_id_fk" FOREIGN KEY ("ori_id") REFERENCES "public"."oris"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oris" ADD CONSTRAINT "oris_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oris" ADD CONSTRAINT "oris_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "port_routes" ADD CONSTRAINT "port_routes_ori_id_oris_id_fk" FOREIGN KEY ("ori_id") REFERENCES "public"."oris"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_runs" ADD CONSTRAINT "prompt_runs_ori_id_oris_id_fk" FOREIGN KEY ("ori_id") REFERENCES "public"."oris"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshot_chunks" ADD CONSTRAINT "snapshot_chunks_snapshot_id_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_ori_id_oris_id_fk" FOREIGN KEY ("ori_id") REFERENCES "public"."oris"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "starts_log" ADD CONSTRAINT "starts_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_ori_id_oris_id_fk" FOREIGN KEY ("ori_id") REFERENCES "public"."oris"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_uq" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "ori_events_ori_seq_idx" ON "ori_events" USING btree ("ori_id","seq");--> statement-breakpoint
CREATE INDEX "oris_user_state_idx" ON "oris" USING btree ("user_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "oris_subdomain_uq" ON "oris" USING btree ("subdomain");--> statement-breakpoint
CREATE INDEX "prompt_runs_ori_idx" ON "prompt_runs" USING btree ("ori_id");--> statement-breakpoint
CREATE INDEX "starts_log_user_created_idx" ON "starts_log" USING btree ("user_id","created_at");