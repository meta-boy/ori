import type { Hono } from "hono";
import { apiKeyId, apiKeySecret, fail, ok, ACTIVE, type ErrorCode, type SecretFile } from "@ori/contract";
import { RepoSelectionRequestSchema, validateEnvContents, validateSecretFiles } from "@ori/contract";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { RUNNABLE } from "@ori/contract";
import { accountSecrets, apiKeys, oris, usageLedger } from "../db/schema";
import { BASE_PATH, type AppDeps, type AppEnv } from "../context";
import { sha256Hex } from "../middleware/auth";
import { applyEnvToOri } from "../lifecycle/applyEnv";

const MAX_ACTIVE = 100;
const RATE_PER_MIN = 10;
const DAY_LIMIT = 1500;

/** Stable per-account environment id, deterministic so GET/POST agree. */
function environmentId(userId: string): string {
  return `env_${sha256Hex(userId).slice(0, 12)}`;
}

/** Shared GET/POST serialization of the stored secret setup. */
function secretsBody(userId: string, envContents: string, secretFiles: SecretFile[]) {
  return { environmentId: environmentId(userId), envContents, secretFiles };
}

/**
 * Account-level endpoints: /me, /limits, /api-keys, /secrets, /repos.
 * All are behind the global auth middleware; the authenticated identity comes
 * from `c.get("userId"|"login"|"email")`.
 */
export function registerUserRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const b = BASE_PATH;

  app.get(`${b}/me`, (c) => {
    return c.json(
      ok("user.info", { user: { login: c.get("login"), email: c.get("email") ?? null } }),
    );
  });

  app.get(`${b}/api-keys`, async (c) => {
    const rows = await deps.db.query.apiKeys.findMany({
      where: and(eq(apiKeys.userId, c.get("userId")!), isNull(apiKeys.revokedAt)),
      orderBy: desc(apiKeys.createdAt),
    });
    return c.json(
      ok("api_key.list", {
        apiKeys: rows.map((k) => ({
          id: k.id,
          name: k.name,
          keyPrefix: k.keyPrefix,
          keyLastFour: k.keyLastFour,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
        })),
      }),
    );
  });

  /**
   * Mint an API key. The secret is in the response and nowhere else, ever again.
   *
   * SESSION ONLY, deliberately. A bearer key cannot mint another: a leaked key would otherwise
   * be self-perpetuating -- revoking it means nothing if the holder already minted replacements.
   * Creating a credential is gated behind the one thing a human holds, the password-backed
   * session. The CLI does not need this route; it is handed a key, it does not create them.
   */
  app.post(`${b}/api-keys`, async (c) => {
    if (c.get("authKind") !== "session") {
      return c.json(
        fail(403, "forbidden", "Creating an API key requires signing in with a password, not an API key."),
        403,
      );
    }

    const raw = await c.req.json().catch(() => null);
    const name = typeof (raw as { name?: unknown } | null)?.name === "string" ? (raw as { name: string }).name.trim() : "";
    if (!name || name.length > 120) {
      return c.json(fail(400, "invalid_name", "A key name of 1-120 characters is required."), 400);
    }

    const userId = c.get("userId")!;
    const secret = apiKeySecret();
    const id = apiKeyId();
    const now = (deps.now ?? (() => new Date()))();
    await deps.db.insert(apiKeys).values({
      id,
      userId,
      name,
      keyPrefix: "ori_live",
      keyLastFour: secret.slice(-4),
      hash: sha256Hex(secret),
      createdAt: now,
    });

    return c.json(
      ok("api_key.created", {
        // The ONLY time this value exists outside the caller's hands. Only its sha256 is stored.
        secret,
        apiKey: {
          id,
          name,
          keyPrefix: "ori_live",
          keyLastFour: secret.slice(-4),
          createdAt: now.toISOString(),
          lastUsedAt: null,
        },
      }),
      201,
    );
  });

  /**
   * Revoke a key. Session-only for the same reason as minting: a leaked key must not be able to
   * revoke the keys you would use to lock it out.
   */
  app.delete(`${b}/api-keys/:keyId`, async (c) => {
    if (c.get("authKind") !== "session") {
      return c.json(
        fail(403, "forbidden", "Revoking an API key requires signing in with a password, not an API key."),
        403,
      );
    }
    const userId = c.get("userId")!;
    const keyId = c.req.param("keyId");
    const now = (deps.now ?? (() => new Date()))();

    // Scoped to the caller's own keys, and already-revoked rows are excluded so a second
    // request is a 404 rather than silently "succeeding" against someone else's key.
    const revoked = await deps.db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });

    if (revoked.length === 0) return c.json(fail(404, "not_found"), 404);
    return c.json(ok("api_key.revoked", { id: keyId, revokedAt: now.toISOString() }));
  });

  app.get(`${b}/limits`, async (c) => {
    const userId = c.get("userId")!;
    const now = (deps.now ?? (() => new Date()))();

    const active = await deps.db.query.oris.findMany({
      where: (t, { and, eq, inArray }) => and(eq(t.userId, userId), inArray(t.state, [...ACTIVE])),
      columns: { state: true },
    });
    const activeOris = active.length;
    const activeStates = [...new Set(active.map((x) => x.state))];

    const [usageRow] = await deps.db
      .select({ seconds: sql<number>`coalesce(sum(${usageLedger.machineSeconds}), 0)::int` })
      .from(usageLedger)
      .where(eq(usageLedger.userId, userId));

    const usedSeconds = usageRow?.seconds ?? 0;
    const quotaSeconds = 2_000_000; // §6 finding: $20 plan = 2M machine-seconds
    const remaining = Math.max(0, quotaSeconds - usedSeconds);

    const canStart = activeOris < MAX_ACTIVE;

    return c.json(
      ok("limits.info", {
        accessTier: "standard",
        blockedReason: null,
        currentLimits: { activeOris, creationRatePerMinute: RATE_PER_MIN, creationRequestsPerDay: DAY_LIMIT },
        standardLimits: { activeOris: MAX_ACTIVE, creationRatePerMinute: RATE_PER_MIN, creationRequestsPerDay: DAY_LIMIT },
        trialLimits: { activeOris: 4, creationRatePerMinute: 5, creationRequestsPerDay: null },
        upgradeEffects: {},
        canStart,
        checkoutRequired: false,
        startBlockedReason: canStart ? null : "start_limit_reached",
        contactMessage: null,
        activeOris,
        activeStates,
        maxActiveOris: MAX_ACTIVE,
        maxCreationRequestsPerMinute: RATE_PER_MIN,
        maxCreationRequestsPerDay: DAY_LIMIT,
        hasPaymentHistory: false,
        package: { planKey: "ori_20", planDollars: 20 },
        oriPlanKey: "ori_20",
        oriPlanDollars: 20,
        subscriptionQuotaSeconds: quotaSeconds,
        subscriptionRemainingSeconds: remaining,
        packBalanceSeconds: remaining,
        creditPurchasedSeconds: 0,
        creditUsedSeconds: usedSeconds,
        liveUsageSeconds: usedSeconds,
        creditSecondsPerDollar: 100_000,
        billingStatus: "active",
        subscriptionStatus: null,
        subscriptionCancelAtPeriodEnd: false,
        hasSubscription: false,
        subscriptionTrialEndsAt: null,
        subscriptionCurrentPeriodEnd: null,
        creditBalanceSeconds: remaining,
      }),
    );
  });

  app.get(`${b}/secrets`, async (c) => {
    const userId = c.get("userId")!;
    const row = await deps.db.query.accountSecrets.findFirst({ where: eq(accountSecrets.userId, userId) });
    const envContents = row?.envContents ?? "";
    const secretFiles = row?.secretFiles ?? [];
    return c.json(ok("secrets.info", secretsBody(userId, envContents, secretFiles)));
  });

  app.post(`${b}/secrets`, async (c) => {
    const userId = c.get("userId")!;
    const body = await c.req.json().catch(() => null);
    if (body === null) {
      return c.json(fail(400, "invalid_json"), 400);
    }

    // Omitted fields are treated as empty values (full replacement, not a patch).
    const envContents: string = typeof body.envContents === "string" ? body.envContents : "";
    const secretFiles: SecretFile[] = Array.isArray(body.secretFiles) ? body.secretFiles : [];

    const envCheck = validateEnvContents(envContents);
    if (!envCheck.ok) return c.json(fail(400, envCheck.code as ErrorCode, envCheck.message), 400);

    const fileCheck = validateSecretFiles(secretFiles);
    if (!fileCheck.ok) return c.json(fail(400, fileCheck.code as ErrorCode, fileCheck.message), 400);

    await deps.db
      .insert(accountSecrets)
      .values({ userId, envContents, secretFiles })
      .onConflictDoUpdate({
        target: accountSecrets.userId,
        set: { envContents, secretFiles },
      });

    // Push the new setup to every live ori of this account. A ori whose guest
    // cannot be reached right now picks the latest values up the next time it
    // starts or resumes (applyEnvToOri runs in provisionToReady), so a failure
    // here is counted, not retried inline.
    const live = await deps.db.query.oris.findMany({
      where: and(eq(oris.userId, userId), inArray(oris.state, [...RUNNABLE, "running", "provisioning", "provisioned", "cloning"])),
    });
    // In parallel: these are independent guest round-trips, and serialising them makes one
    // unreachable ori (a 5s connect timeout) delay every ori behind it in the same request.
    const results = await Promise.all(live.map((o) => applyEnvToOri(deps, o.id)));
    const updated = results.filter((r) => r.ok).length;
    const failed = results.length - updated;

    return c.json(
      ok("secrets.updated", {
        ...secretsBody(userId, envContents, secretFiles),
        success: true,
        pushed: { updated, failed },
      }),
    );
  });

  // T-P2-08 — v1 STUB: GitHub OAuth + the App are non-goals for v1 (§2). No
  // installations exist, so GET always returns empty groups and POST echoes
  // the caller's selection back verbatim as if accepted. Replace with a real
  // GitHub App integration (P13 backlog) without changing these response shapes.
  app.get(`${b}/repos`, async (c) => {
    const userId = c.get("userId")!;
    return c.json(
      ok("repos.list", {
        environmentId: environmentId(userId),
        installations: [],
        selectedRepositories: [],
        pageInfo: { nextCursor: null, hasMore: false, limit: 100 },
      }),
    );
  });

  app.post(`${b}/repos`, async (c) => {
    const userId = c.get("userId")!;
    const body = await c.req.json().catch(() => null);
    if (body === null) {
      return c.json(fail(400, "invalid_json"), 400);
    }
    const parsed = RepoSelectionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(fail(400, "invalid_json", "repositoryId is required"), 400);
    }
    const { repositoryId, baseBranch } = parsed.data;
    return c.json(
      ok("repos.updated", {
        success: true,
        environmentId: environmentId(userId),
        selectedRepositories: [
          {
            databaseId: repositoryId,
            baseBranch,
            setupRoutineId: null,
            setupScript: "",
            setupBlocking: false,
            preCommitHooks: [],
          },
        ],
      }),
    );
  });
}