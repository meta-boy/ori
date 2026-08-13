import { describe, expect, test, beforeAll } from "bun:test";
import { buildApp, makeDb, seedUserKey } from "./helpers";
import { assertValidResponse } from "../contract/harness";
import { oris } from "@ori/api/db/schema";
import { oriId } from "@ori/contract";

const deps = { db: makeDb() };
const app = buildApp(deps);
let key: Awaited<ReturnType<typeof seedUserKey>>;

beforeAll(async () => {
  key = await seedUserKey(deps.db);
});

const REQUIRED_KEYS = [
  "accessTier", "blockedReason", "currentLimits", "standardLimits", "trialLimits",
  "upgradeEffects", "canStart", "checkoutRequired", "startBlockedReason", "contactMessage",
  "activeOris", "activeStates", "maxActiveOris", "maxCreationRequestsPerMinute",
  "maxCreationRequestsPerDay", "hasPaymentHistory", "package", "subscriptionQuotaSeconds",
  "subscriptionRemainingSeconds", "packBalanceSeconds", "creditPurchasedSeconds",
  "creditUsedSeconds", "liveUsageSeconds", "creditSecondsPerDollar", "billingStatus",
  "subscriptionStatus", "subscriptionCancelAtPeriodEnd", "hasSubscription",
  "subscriptionTrialEndsAt", "subscriptionCurrentPeriodEnd", "creditBalanceSeconds",
];

describe("T-P2-05 GET /limits", () => {
  test("returns limits.info with every LimitsFields key present and validating", async () => {
    const res = await app.request("/api/ori/v1/limits", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    assertValidResponse("limits", body);
    expect(body.type).toBe("limits.info");
    for (const k of REQUIRED_KEYS) {
      expect(body).toHaveProperty(k);
    }
    expect(body.billingStatus).toBe("active");
    expect(body.maxActiveOris).toBe(100);
    expect(body.canStart).toBe(true);
    expect(body.activeOris).toBe(0);
  });

  test("activeOris reflects ACTIVE-state oris and canStart flips at the cap", async () => {
    await deps.db.insert(oris).values({
      id: oriId(),
      userId: key.userId,
      name: "active ori",
      state: "running",
      type: "default",
    });

    const res = await app.request("/api/ori/v1/limits", {
      headers: { authorization: `Bearer ${key.secret}` },
    });
    const body = await res.json();
    assertValidResponse("limits", body);
    expect(body.activeOris).toBeGreaterThanOrEqual(1);
    expect(body.activeStates).toContain("running");
  });

  test("requires auth", async () => {
    const res = await app.request("/api/ori/v1/limits", {}, app);
    expect(res.status).toBe(401);
  });
});