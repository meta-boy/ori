import { z } from "zod";
import { MACHINE_TYPES, REQUESTABLE_TYPES } from "./machines";

/** date-time (RFC3339) string, tolerant of offsets / Z. */
const dt = () => z.iso.datetime({ offset: true });
const dtNull = () => z.iso.datetime({ offset: true }).nullable();

/* ------------------------------------------------------------------------- *
 * Shared primitives
 * ------------------------------------------------------------------------- */
export const OriIdSchema = z
  .string()
  .regex(/^or_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/, "invalid ori id");
export const SnapshotIdSchema = z
  .uuid()
  .refine((v) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v), "expected uuid v4");

export const OriStateSchema = z.enum([
  "init",
  "provisioning",
  "provisioned",
  "cloning",
  "ready",
  "idle",
  "running",
  "archiving",
  "archived",
  "error",
]);

// Derived from machines.ts, never re-listed: a type that exists in the table but not in the
// validator is a 400 on a documented value, which is what happened when `nano` was added.
export const MachineTypeSchema = z.enum(MACHINE_TYPES);
export const RequestableMachineTypeSchema = z.enum(REQUESTABLE_TYPES);

export const LimitQuerySchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(200)
  .default(100);
export const CursorQuerySchema = z.string().nullable().optional();
export const SortQuerySchema = z.enum(["asc", "desc"]).default("desc");

export const NameSchema = z.string().min(1).max(120);
export const TtlSecondsSchema = z
  .union([z.number().int().min(1).max(2592000), z.null()])
  .default(3600);
export const PageInfoSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  limit: z.number().int(),
});

/* ------------------------------------------------------------------------- *
 * Request bodies
 * ------------------------------------------------------------------------- */
export const CreateOriRequestSchema = z
  .object({
    type: RequestableMachineTypeSchema.default("default"),
    ttlSeconds: TtlSecondsSchema,
    env: z.record(z.string(), z.string()).optional(),
    noEnv: z.boolean().default(false),
    /**
     * May this ori run a graphical session at all? Off by default.
     *
     * NOT a memory optimisation — the desktop units already ship disabled and start only when
     * /desktop is called (guest-agent/desktop.ts), so a headless ori costs nothing for them
     * either way. This is a guard rail: on a 512MB nano an accidental `ori desktop` from an
     * agent would start Xvfb, budgie and VNC on a box with no room for them. Opting in makes
     * that a decision rather than an accident.
     */
    display: z.boolean().default(false),
  })
  .passthrough();

export const StopRequestSchema = z.object({ force: z.boolean().default(false) }).passthrough();

export const ResumeRequestSchema = z
  .object({
    type: RequestableMachineTypeSchema.optional(),
    noEnv: z.boolean().optional(),
  })
  .passthrough();

export const UpdateOriRequestSchema = z
  .object({
    name: NameSchema.optional(),
    ttlSeconds: TtlSecondsSchema.optional(),
    subdomain: z
      .string()
      .min(3)
      .max(40)
      .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
      .optional(),
  })
  .passthrough();

export const ForkOriRequestSchema = z
  .object({
    env: z.record(z.string(), z.string()).optional(),
    noEnv: z.boolean().optional(),
    type: RequestableMachineTypeSchema.optional(),
  })
  .passthrough();

export const PromptRequestSchema = z
  .object({
    provider: z.enum(["codex", "claude-code", "claude"]),
    model: z.string().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
    prompt: z.string().min(1),
  })
  .passthrough();

export const RepoSelectionRequestSchema = z
  .object({
    repositoryId: z.string(),
    baseBranch: z.string().default("main"),
  })
  .passthrough();

export const SecretFileSchema = z.object({
  path: z.string(),
  contents: z.string(),
});

export const SecretsUpdateRequestSchema = z
  .object({
    envContents: z.string().optional(),
    secretFiles: z.array(SecretFileSchema).optional(),
  })
  .passthrough();

export const SshKeyRequestSchema = z
  .object({
    key: z.string().regex(/^ssh-(ed25519|rsa|ecdsa)\s+\S+/),
  })
  .passthrough();

export const DesktopRequestSchema = z.object({ publicAccess: z.boolean().default(false) }).passthrough();

export const FileWriteRequestSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  })
  .passthrough();

export const CommandRequestSchema = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    timeoutSeconds: z.number().int().min(1).max(60).default(30),
  })
  .passthrough();

/* ------------------------------------------------------------------------- *
 * Core entities
 * ------------------------------------------------------------------------- */
export const OriSchema = z.object({
  id: OriIdSchema,
  name: z.string(),
  state: OriStateSchema,
  type: MachineTypeSchema.optional(),
  vcpu: z.number().int().optional(),
  memoryGB: z.number().int().optional(),
  billingMultiplier: z.number().optional(),
  url: z.string().url().nullable().optional(),
  ip: z.string().nullable().optional(),
  createdAt: dtNull().optional(),
  updatedAt: dtNull().optional(),
  archiveAfter: dtNull().optional(),
  desktopAvailable: z.boolean(),
  desktopUrl: z.string().url().nullable().optional(),
  snapshotAvailable: z.boolean(),
  snapshotCompletedAt: dtNull().optional(),
  subdomain: z.string().nullable().optional(),
  lastSnapshotAttemptAt: dtNull().optional(),
  lastSnapshotStatus: z
    .enum(["queued", "in_progress", "completed", "failed", "cancelled"])
    .nullable()
    .optional(),
}).passthrough();

export const ApiKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    keyPrefix: z.string(),
    keyLastFour: z.string(),
    createdAt: dt(),
    lastUsedAt: dtNull().optional(),
  })
  .passthrough();

export const RepositorySchema = z.object({}).passthrough();

export const SelectedRepositorySchema = z.object({}).passthrough();

export const RepositoryInstallationSchema = z
  .object({
    type: z.string().optional(),
    accountLogin: z.string().optional(),
    accountAvatarUrl: z.string().url().nullable().optional(),
    repositories: z.array(RepositorySchema).optional(),
  })
  .passthrough();

export const LimitsBaseSchema = z.object({
  activeOris: z.number().int().optional(),
  creationRatePerMinute: z.number().int().optional(),
  creationRequestsPerDay: z.number().int().nullable().optional(),
});

export const LimitsFieldsSchema = z
  .object({
    accessTier: z.string().optional(),
    blockedReason: z.string().nullable().optional(),
    currentLimits: LimitsBaseSchema.optional(),
    standardLimits: LimitsBaseSchema.optional(),
    trialLimits: LimitsBaseSchema.optional(),
    upgradeEffects: z.record(z.string(), z.unknown()).optional(),
    canStart: z.boolean().optional(),
    checkoutRequired: z.boolean().optional(),
    startBlockedReason: z.string().nullable().optional(),
    contactMessage: z.string().nullable().optional(),
    activeOris: z.number().int().optional(),
    activeStates: z.array(z.string()).optional(),
    maxActiveOris: z.number().int().optional(),
    maxCreationRequestsPerMinute: z.number().int().optional(),
    maxCreationRequestsPerDay: z.number().int().nullable().optional(),
    hasPaymentHistory: z.boolean().optional(),
    package: z.record(z.string(), z.unknown()).optional(),
    subscriptionQuotaSeconds: z.number().int().optional(),
    subscriptionRemainingSeconds: z.number().int().optional(),
    packBalanceSeconds: z.number().int().optional(),
    creditPurchasedSeconds: z.number().int().optional(),
    creditUsedSeconds: z.number().int().optional(),
    liveUsageSeconds: z.number().int().optional(),
    creditSecondsPerDollar: z.number().int().optional(),
    billingStatus: z.string().optional(),
    subscriptionStatus: z.string().nullable().optional(),
    subscriptionCancelAtPeriodEnd: z.boolean().optional(),
    hasSubscription: z.boolean().optional(),
    subscriptionTrialEndsAt: dtNull().optional(),
    subscriptionCurrentPeriodEnd: dtNull().optional(),
    creditBalanceSeconds: z.number().int().optional(),
  })
  .passthrough();

export const PromptRunStatusSchema = z.enum(["sending", "queued", "running", "finished", "failed"]);

export const PromptRunSchema = z
  .object({
    id: z.string(),
    promptId: z.string(),
    oriId: OriIdSchema,
    status: PromptRunStatusSchema,
    done: z.boolean(),
    createdAt: dtNull().optional(),
    model: z.string().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
  })
  .passthrough();

/* --- events --- */
export const PromptEventDataSchema = z
  .object({
    prompt: z.string(),
    status: PromptRunStatusSchema,
    is_reverted: z.boolean().optional(),
  })
  .passthrough();
export const ResponseEventDataSchema = z
  .object({
    content: z.string(),
    model: z.string().nullable().optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    is_streaming: z.boolean().optional(),
  })
  .passthrough();
export const GitCheckpointEventDataSchema = z
  .object({
    commitSha: z.string(),
    commitMessage: z.string(),
    commitUrl: z.string().nullable().optional(),
    branch: z.string(),
    filesChanged: z.number().int().optional(),
    additions: z.number().int().optional(),
    deletions: z.number().int().optional(),
    pushed: z.boolean().optional(),
  })
  .passthrough();

export const ErrorEventTypeSchema = z.enum(["usage_limit", "shield"]);
export const CompletionEventTypeSchema = z.enum(["task_notification", "compaction_complete"]);

export const OriEventSchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  timestamp: z.number().int().optional(),
  taskId: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/* --- snapshots --- */
export const SnapshotSummarySchema = z
  .object({
    id: SnapshotIdSchema,
    oriId: OriIdSchema,
    status: z.enum(["completed"]),
    kind: z.enum(["base", "incremental"]).nullable().optional(),
    generation: z.number().int(),
    chainId: SnapshotIdSchema.nullable().optional(),
    createdAt: dt(),
    completedAt: dtNull().optional(),
    sizeBytes: z.number().int(),
    fileCount: z.number().int(),
    contentSizeBytes: z.number().int().nullable().optional(),
    contentFileCount: z.number().int().nullable().optional(),
  })
  .passthrough();

export const SnapshotTreeEntrySchema = z
  .object({
    path: z.string(),
    kind: z.enum(["file", "dir", "symlink"]),
    size: z.number().int().optional(),
  })
  .passthrough();

export const SnapshotChunkSchema = z
  .object({
    snapshotId: SnapshotIdSchema,
    generation: z.number().int(),
    chunkIndex: z.number().int(),
    r2Key: z.string(),
    sizeBytes: z.number().int(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    signedUrl: z.string().url(),
  })
  .passthrough();

/* ------------------------------------------------------------------------- *
 * Enveloped responses
 * ------------------------------------------------------------------------- */
const ok = () => z.literal(true);

export const ErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  type: z.literal("ori.error"),
  status: z.number().int(),
  code: z.string(),
  message: z.string(),
  requestId: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().int(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
}).passthrough();

export const SuccessBaseSchema = z.object({ ok: ok(), type: z.string() }).passthrough();

export const MeResponseSchema = z.object({
  ok: ok(),
  type: z.literal("user.info"),
  user: z.object({
    login: z.string(),
    email: z.string().nullable().optional(),
  }),
}).passthrough();

export const LimitsResponseSchema = LimitsFieldsSchema.extend({
  ok: ok(),
  type: z.literal("limits.info"),
}).passthrough();

export const ReposResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("repos.list"),
    installations: z.array(RepositoryInstallationSchema),
    environmentId: z.string(),
    selectedRepositories: z.array(SelectedRepositorySchema),
    pageInfo: PageInfoSchema.optional(),
  })
  .passthrough();

export const RepoSelectionResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("repos.updated"),
    success: z.boolean(),
    environmentId: z.string(),
    selectedRepositories: z.array(SelectedRepositorySchema),
  })
  .passthrough();

export const SecretsResponseSchema = z
  .object({
    ok: ok(),
    type: z.string(), // secrets.info | secrets.updated
    success: z.boolean().optional(),
    environmentId: z.string(),
    envContents: z.string(),
    secretFiles: z.array(SecretFileSchema),
    pushed: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const OriListResponseSchema = z
  .object({ ok: ok(), type: z.literal("ori.list"), oris: z.array(OriSchema), pageInfo: PageInfoSchema.optional() })
  .passthrough();

export const OriInfoResponseSchema = z
  .object({ ok: ok(), type: z.literal("ori.info"), ori: OriSchema })
  .passthrough();

export const CreateOriResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("ori.created"),
    status: z.literal("provisioning"),
    ttlSeconds: z.number().int().nullable(),
    ori: OriSchema,
  })
  .passthrough();

export const OriActionResponseSchema = z
  .object({
    ok: ok(),
    type: z.string(),
    id: OriIdSchema,
    status: z.string(),
    ori: OriSchema.nullable().optional(),
  })
  .passthrough();

export const PromptRunResponseSchema = z
  .object({ ok: ok(), type: z.literal("prompt.run"), id: OriIdSchema, promptRun: PromptRunSchema })
  .passthrough();

export const PromptResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("prompt.queued"),
    id: OriIdSchema,
    promptId: z.string(),
    promptRun: PromptRunSchema,
    status: z.literal("queued"),
    provider: z.string(),
    model: z.string().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
  })
  .passthrough();

export const EventsResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("events.list"),
    id: OriIdSchema,
    events: z.array(OriEventSchema),
    pageInfo: PageInfoSchema.optional(),
  })
  .passthrough();

export const DesktopResponseSchema = z
  .object({
    ok: ok(),
    type: z.string(),
    success: z.boolean().optional(),
    desktopUrl: z.string().url().nullable().optional(),
    ip: z.string().nullable().optional(),
    mode: z.string().optional(),
    provisioning: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const SshKeyResponseSchema = z
  .object({ ok: ok(), type: z.literal("ssh_key.configured"), success: z.boolean().optional(), machineIp: z.string().nullable().optional(), sshUser: z.string().optional() })
  .passthrough();

export const ApiKeysResponseSchema = z
  .object({ ok: ok(), type: z.literal("api_key.list"), apiKeys: z.array(ApiKeySchema) })
  .passthrough();

export const FileReadResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("file.read"),
    success: z.boolean(),
    path: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    size: z.number().int(),
    content: z.string(),
  })
  .passthrough();

export const FileWriteResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("file.written"),
    success: z.boolean(),
    path: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    size: z.number().int(),
  })
  .passthrough();

export const commandResponseShape = {
  ok: ok(),
  type: z.literal("command.finished"),
  success: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean().optional(),
  stderrTruncated: z.boolean().optional(),
  timedOut: z.boolean(),
  cwd: z.string().optional(),
  startedAt: dt().optional(),
  finishedAt: dt().optional(),
} as const;

export const CommandResponseSchema = z.object(commandResponseShape).passthrough();

export const SnapshotListResponseSchema = z
  .object({ ok: ok(), type: z.literal("snapshot.list"), snapshots: z.array(SnapshotSummarySchema), pageInfo: PageInfoSchema.optional() })
  .passthrough();

export const SnapshotLatestResponseSchema = z
  .object({ ok: ok(), type: z.literal("snapshot.latest"), snapshot: SnapshotSummarySchema.nullable() })
  .passthrough();

export const SnapshotTreeResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("snapshot.tree"),
    snapshotId: SnapshotIdSchema,
    oriId: OriIdSchema,
    generation: z.number().int(),
    treeAvailable: z.boolean(),
    truncated: z.boolean(),
    fileCount: z.number().int(),
    totalSizeBytes: z.number().int(),
    entries: z.array(SnapshotTreeEntrySchema),
    reason: z.string().optional(),
  })
  .passthrough();

export const SnapshotDownloadResponseSchema = z
  .object({
    ok: ok(),
    type: z.literal("snapshot.download"),
    snapshotId: SnapshotIdSchema,
    oriId: OriIdSchema,
    kind: z.enum(["base", "incremental", "legacy"]),
    generation: z.number().int(),
    expiresInSeconds: z.number().int(),
    reconstruct: z.string(),
    inventory: z
      .object({ r2Key: z.string(), signedUrl: z.string().url() })
      .nullable()
      .optional(),
    chunks: z.array(SnapshotChunkSchema),
  })
  .passthrough();

/* ------------------------------------------------------------------------- *
 * Generated types
 * ------------------------------------------------------------------------- */
export type OriId = z.infer<typeof OriIdSchema>;
export type SnapshotId = z.infer<typeof SnapshotIdSchema>;
export type RequestableMachineType = z.infer<typeof RequestableMachineTypeSchema>;
export type Ori = z.infer<typeof OriSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type SecretFile = z.infer<typeof SecretFileSchema>;
export type PageInfo = z.infer<typeof PageInfoSchema>;
export type PromptRun = z.infer<typeof PromptRunSchema>;
export type OriEvent = z.infer<typeof OriEventSchema>;
export type SnapshotSummary = z.infer<typeof SnapshotSummarySchema>;
export type SnapshotChunk = z.infer<typeof SnapshotChunkSchema>;
export type CreateOriRequest = z.infer<typeof CreateOriRequestSchema>;
export type StopRequest = z.infer<typeof StopRequestSchema>;
export type ResumeRequest = z.infer<typeof ResumeRequestSchema>;
export type UpdateOriRequest = z.infer<typeof UpdateOriRequestSchema>;
export type PromptRequest = z.infer<typeof PromptRequestSchema>;
export type CommandRequest = z.infer<typeof CommandRequestSchema>;
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;