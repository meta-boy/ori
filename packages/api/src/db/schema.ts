import {
  bigint as bigInt,
  bigserial as bigSerial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { desc } from "drizzle-orm";

/* §6 schema — one table per line of the plan. snake_case, timestamptz for date-time. */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  login: text("login").notNull(),
  email: text("email"),
  /**
   * Argon2id hash from Bun.password. Nullable because users minted by
   * scripts/create-key.ts are service identities that never log in to the dashboard — a
   * null here means "cannot sign in", not "empty password".
   */
  passwordHash: text("password_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // sak_
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(), // ori_live
    keyLastFour: text("key_last_four").notNull(),
    hash: text("hash").notNull(), // sha256 hex of the raw secret
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.hash)],
);

export const hosts = pgTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  driver: text("driver").notNull(),
  capacityVcpu: integer("capacity_vcpu").notNull(),
  capacityMemGb: integer("capacity_mem_gb").notNull(),
  ip: text("ip"),
  status: text("status").notNull().default("ready"),
});

export const oris = pgTable(
  "oris",
  {
    id: text("id").primaryKey(), // or_
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    state: text("state").notNull().default("init"),
    type: text("type").notNull().default("default"),
    hostId: text("host_id").references(() => hosts.id),
    machineId: text("machine_id"),
    ip: text("ip"),
    subdomain: text("subdomain"),
    noEnv: boolean("no_env").notNull().default(false),
  /** Was this ori created with the graphical session? Drives the desktop units and /desktop. */
  display: boolean("display").notNull().default(false),
    machineTokenHash: text("machine_token_hash"),
    agentTokenHash: text("agent_token_hash"),
    ttlSeconds: integer("ttl_seconds"),
    archiveAfter: timestamp("archive_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    desktopAvailable: boolean("desktop_available").notNull().default(false),
    desktopToken: text("desktop_token"),
    desktopExpiresAt: timestamp("desktop_expires_at", { withTimezone: true }),
    snapshotAvailable: boolean("snapshot_available").notNull().default(false),
    snapshotCompletedAt: timestamp("snapshot_completed_at", { withTimezone: true }),
    lastSnapshotAttemptAt: timestamp("last_snapshot_attempt_at", { withTimezone: true }),
    lastSnapshotStatus: text("last_snapshot_status"), // queued|in_progress|completed|failed|cancelled
    /**
     * Consecutive auto-snapshot attempts the guest answered "skipped" (nothing
     * changed since the last successful backup). The reaper backs the cadence
     * off as this grows, so an idle sandbox stops paying for a full-tree probe
     * and a credential mint every minute.
     * Advanced only by a skip (takeSnapshot); reset to 0 by registerSnapshot on
     * EITHER outcome it handles — a success means the disk changed, and a failure
     * means its state is unknown, so both belong back at the fast cadence.
     */
    snapshotSkipStreak: integer("snapshot_skip_streak").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    index("oris_user_state_idx").on(t.userId, t.state),
    uniqueIndex("oris_subdomain_uq").on(t.subdomain),
    // The oris list (routes/oris.ts) pages a user's rows by created_at, so a
    // user_id-prefixed index must lead with that column; user+state alone cannot
    // serve the ORDER BY.
    index("oris_user_created_idx").on(t.userId, t.createdAt),
    // The reaper's scans filter on state alone (inArray), which the user_id-first
    // index cannot reach.
    index("oris_state_idx").on(t.state),
  ],
);

export const oriEnv = pgTable(
  "ori_env",
  {
    oriId: text("ori_id")
      .notNull()
      .references(() => oris.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.oriId, t.key] })],
);

export const oriEvents = pgTable(
  "ori_events",
  {
    seq: bigSerial("seq", { mode: "number" }).primaryKey(),
    oriId: text("ori_id")
      .notNull()
      .references(() => oris.id),
    id: text("id"),
    type: text("type").notNull(),
    timestamp: bigInt("timestamp", { mode: "number" }).notNull(),
    taskId: text("task_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (t) => [index("ori_events_ori_seq_idx").on(t.oriId, t.seq)],
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey(),
    oriId: text("ori_id")
      .notNull()
      .references(() => oris.id),
    chainId: uuid("chain_id"),
    generation: integer("generation").notNull().default(0),
    kind: text("kind"), // base|incremental
    status: text("status").notNull().default("completed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    sizeBytes: bigInt("size_bytes", { mode: "number" }).notNull().default(0),
    fileCount: integer("file_count").notNull().default(0),
    contentSizeBytes: bigInt("content_size_bytes", { mode: "number" }),
    contentFileCount: integer("content_file_count"),
    resticId: text("restic_id"),
  },
  (t) => [
    // The snapshot list and latest endpoints filter one ori by status='completed' and page
    // newest-first, so created_at must come after status: an (ori_id, created_at) index would
    // still scan every row of the ori with the status applied only afterwards.
    index("snapshots_ori_status_created_idx").on(t.oriId, t.status, desc(t.createdAt)),
  ],
);

export const snapshotChunks = pgTable(
  "snapshot_chunks",
  {
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshots.id),
    chunkIndex: integer("chunk_index").notNull(),
    r2Key: text("r2_key").notNull(),
    sizeBytes: bigInt("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.chunkIndex] })],
);

export const promptRuns = pgTable(
  "prompt_runs",
  {
    id: text("id").primaryKey(),
    promptId: text("prompt_id").notNull(),
    oriId: text("ori_id")
      .notNull()
      .references(() => oris.id),
    status: text("status").notNull().default("queued"),
    provider: text("provider"),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    prompt: text("prompt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    done: boolean("done").notNull().default(false),
  },
  (t) => [index("prompt_runs_ori_idx").on(t.oriId)],
);

export const portRoutes = pgTable(
  "port_routes",
  {
    oriId: text("ori_id")
      .notNull()
      .references(() => oris.id),
    port: integer("port").notNull(),
    subdomain: text("subdomain").notNull(),
    title: text("title"),
    public: boolean("public").notNull().default(false),
    token: text("token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.oriId, t.port] })],
);

export const accountSecrets = pgTable("account_secrets", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id),
  envContents: text("env_contents"),
  secretFiles: jsonb("secret_files").$type<{ path: string; contents: string }[]>(),
});

export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: bigSerial("id", { mode: "number" }).primaryKey(),
    oriId: text("ori_id").references(() => oris.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    seconds: integer("seconds").notNull().default(0),
    multiplier: doublePrecision("multiplier").notNull().default(1),
    machineSeconds: integer("machine_seconds").notNull().default(0),
  },
  (t) => [
    // closeUsageLedger runs "newest row per ori" once per billable sandbox per reaper tick,
    // and /limits sums machine_seconds per user; with no indexes both were full scans that
    // grew with the whole ledger.
    index("usage_ledger_ori_to_idx").on(t.oriId, desc(t.toTs)),
    index("usage_ledger_user_idx").on(t.userId),
  ],
);

export const startsLog = pgTable("starts_log", {
  id: bigSerial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  oriId: text("ori_id"),
  kind: text("kind").notNull(), // create|fork|resume
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("starts_log_user_created_idx").on(t.userId, t.createdAt),
  // The platform-wide ceilings (rateLimit.ts) count rows by created_at alone, so the
  // user_id-first index can never serve them.
  index("starts_log_created_idx").on(t.createdAt),
]);

/**
 * Dashboard sessions.
 *
 * A row per active login, so signing out actually ends the session. The token itself is
 * HMAC-signed and self-describing (see api/src/auth/session.ts), but the signature alone is
 * never enough: the row must exist and be unexpired, exactly like desktop tokens. Storing only
 * the hash means a database dump does not hand over live sessions.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** sha256 of the token. Never the token. */
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Coarse provenance for "which sessions are open" — never used for auth decisions. */
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_token_hash_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/**
 * Sign-up invites.
 *
 * Registration is invite-only on purpose. This control plane is meant to be reachable through a
 * tunnel, and every account that exists can spawn containers on the host — open registration
 * would let anyone who learns the URL farm the machine. Mint one with
 * scripts/create-invite.ts.
 */
export const invites = pgTable("invites", {
  id: text("id").primaryKey(),
  /** sha256 of the invite token, for the same reason as sessions. */
  tokenHash: text("token_hash").notNull().unique(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** Set the moment it is redeemed, so an invite is single-use. */
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByUserId: text("used_by_user_id").references(() => users.id),
});


/**
 * A bounded resource time series per sandbox.
 *
 * Deliberately small and lossy: the dashboard draws a sparkline, not a monitoring system. The
 * reaper prunes to the most recent MAX_METRIC_SAMPLES rows per ori on every tick, so this table
 * cannot grow without bound and nobody has to remember to clean it.
 */
export const oriMetrics = pgTable(
  "ori_metrics",
  {
    id: bigSerial("id", { mode: "number" }).primaryKey(),
    oriId: text("ori_id")
      .notNull()
      .references(() => oris.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    cpuPercent: doublePrecision("cpu_percent").notNull().default(0),
    memBytes: doublePrecision("mem_bytes").notNull().default(0),
    memLimitBytes: doublePrecision("mem_limit_bytes").notNull().default(0),
    blockIoBytes: doublePrecision("block_io_bytes").notNull().default(0),
    netIoBytes: doublePrecision("net_io_bytes").notNull().default(0),
    /**
     * Disk of the sandbox's root filesystem. `docker stats` does not report this at all — it
     * comes from `df` inside the container.
     */
    diskUsedBytes: doublePrecision("disk_used_bytes").notNull().default(0),
    diskTotalBytes: doublePrecision("disk_total_bytes").notNull().default(0),
    /**
     * IO CONTENTION as a percentage, not cumulative bytes.
     *
     * From /proc/pressure/io (kernel PSI): the share of time work was stalled waiting on IO.
     * That is the number worth plotting next to cpu and memory percentages — cumulative bytes
     * only ever climb, so a chart of them says nothing about whether the sandbox is struggling.
     */
    ioPercent: doublePrecision("io_percent").notNull().default(0),
    /** Top processes by cpu at sample time: [{ cmd, cpuPercent, rssBytes }]. */
    topProcesses: jsonb("top_processes"),
  },
  (t) => [index("ori_metrics_ori_at_idx").on(t.oriId, t.at)],
);
