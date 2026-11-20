import { describe, expect, it } from "vitest";
import {
  parseRouterStatus,
  selectCriticalUtilization,
  type AccountStatus,
} from "./status-model";

function baseAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "main-account",
    provider: "anthropic_subscription",
    enabled: true,
    healthy: true,
    busy: false,
    inFlightRequests: 1,
    activeSessions: 2,
    requestCount: 10,
    errorCount: 1,
    lastUsedMs: 1_000,
    cooldownUntilMs: 0,
    ...overrides,
  };
}

function health(accounts: unknown[]) {
  return {
    status: "ok",
    version: "0.13.0",
    mode: "standalone",
    target: "https://api.anthropic.com",
    uptime: 123,
    totalRequests: 20,
    totalErrors: 2,
    operational: {
      providers: {
        anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
        openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
        xai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
      },
    },
    accounts,
    recentLogs: [{ sessionId: "must-not-cross-the-boundary" }],
    futureField: { accepted: true },
  };
}

describe("parseRouterStatus", () => {
  it("normalizes Anthropic usage windows and prefers detailed usage values", () => {
    const snapshot = parseRouterStatus(health([
      baseAccount({
        rateLimits: {
          fiveHourUtil: 0.2,
          fiveHourReset: 1_700_000_000,
          sevenDayUtil: 0.4,
          sevenDayReset: 1_700_100_000,
          usage: {
            fiveHour: { utilization: 0.31, resetAt: 1_800_000_000 },
            sevenDay: { utilization: 0.59, resetAt: 1_800_100_000 },
            fetchedAt: 1_234,
            fetchStatus: "fresh",
          },
        },
      }),
    ]), 5_000);

    expect(snapshot.accounts[0]).toMatchObject({
      id: "main-account",
      provider: "anthropic",
      allowanceUpdatedAt: 1_234,
      allowanceFreshness: "fresh",
      windows: [
        {
          id: "five-hour",
          label: "5 hours",
          utilization: 0.31,
          resetAtMs: 1_800_000_000_000,
          windowMinutes: 300,
        },
        {
          id: "seven-day",
          label: "7 days",
          utilization: 0.59,
          resetAtMs: 1_800_100_000_000,
          windowMinutes: 10_080,
        },
      ],
    });
    expect(snapshot.fetchedAt).toBe(5_000);
    expect(snapshot.stale).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("recentLogs");
  });

  it("falls back to legacy Anthropic utilization fields", () => {
    const snapshot = parseRouterStatus(health([
      baseAccount({
        rateLimits: {
          fiveHourUtil: 0.2,
          fiveHourReset: 1_700_000_000,
          sevenDayUtil: 0.59,
          sevenDayReset: 1_700_100_000,
          lastUpdated: 2_000,
        },
      }),
    ]), 5_000);

    expect(snapshot.accounts[0]?.windows.map(window => ({
      label: window.label,
      utilization: window.utilization,
    }))).toEqual([
      { label: "5 hours", utilization: 0.2 },
      { label: "7 days", utilization: 0.59 },
    ]);
    expect(snapshot.accounts[0]?.allowanceUpdatedAt).toBe(2_000);
  });

  it("normalizes bounded OpenAI buckets, window labels, and credit state", () => {
    const snapshot = parseRouterStatus(health([
      baseAccount({
        id: "codex-account",
        provider: "openai_subscription",
        codexRateLimits: {
          status: "ok",
          plan: "prolite",
          buckets: [
            {
              limitId: "codex",
              label: "Codex",
              primary: {
                utilization: 0.25,
                resetAt: 1_800_000_000,
                windowMinutes: 300,
              },
              secondary: {
                utilization: 0.75,
                resetAt: 1_800_100_000,
                windowMinutes: 10_080,
              },
            },
          ],
          credits: { hasCredits: true, unlimited: false, balance: "12.50" },
          resetCredits: { available: 2 },
          lastUpdated: 4_000,
        },
      }),
    ]), 5_000);

    expect(snapshot.accounts[0]).toMatchObject({
      id: "codex-account",
      provider: "openai",
      plan: "prolite",
      credits: {
        hasCredits: true,
        unlimited: false,
        balance: "12.50",
        resetCreditsAvailable: 2,
      },
      windows: [
        {
          id: "codex-primary",
          label: "5 hours",
          utilization: 0.25,
          windowMinutes: 300,
        },
        {
          id: "codex-secondary",
          label: "7 days",
          utilization: 0.75,
          windowMinutes: 10_080,
        },
      ],
    });
  });

  it("clamps finite utilization and rejects invalid numeric values", () => {
    const snapshot = parseRouterStatus(health([
      baseAccount({
        rateLimits: {
          fiveHourUtil: -1,
          fiveHourReset: -50,
          sevenDayUtil: 1.5,
          sevenDayReset: Number.NaN,
        },
        requestCount: -2,
        errorCount: Number.POSITIVE_INFINITY,
      }),
    ]), 5_000);

    expect(snapshot.accounts[0]?.windows).toEqual([
      {
        id: "five-hour",
        label: "5 hours",
        utilization: 0,
        resetAtMs: null,
        windowMinutes: 300,
      },
      {
        id: "seven-day",
        label: "7 days",
        utilization: 1,
        resetAtMs: null,
        windowMinutes: 10_080,
      },
    ]);
    expect(snapshot.accounts[0]?.requestCount).toBe(0);
    expect(snapshot.accounts[0]?.errorCount).toBe(0);
  });

  it("bounds strings and account/bucket arrays while ignoring additive fields", () => {
    const oversizedAccounts = Array.from({ length: 140 }, (_, index) => baseAccount({
      id: `${index}-${"x".repeat(300)}`,
      provider: "openai_subscription",
      unknown: { nested: true },
      codexRateLimits: {
        buckets: Array.from({ length: 20 }, (__, bucketIndex) => ({
          limitId: `bucket-${bucketIndex}`,
          label: "y".repeat(300),
          primary: { utilization: 0.5, resetAt: 0, windowMinutes: 60 },
        })),
      },
    }));

    const snapshot = parseRouterStatus(health(oversizedAccounts), 5_000);

    expect(snapshot.accounts).toHaveLength(100);
    expect(snapshot.accounts[0]?.id.length).toBeLessThanOrEqual(128);
    expect(snapshot.accounts[0]?.windows).toHaveLength(8);
    expect(snapshot.accounts[0]?.windows[0]?.label.length).toBeLessThanOrEqual(128);
  });

  it("rejects incompatible root payloads", () => {
    expect(() => parseRouterStatus(null, 1)).toThrow("Invalid CC-Router status payload");
    expect(() => parseRouterStatus({ status: "ok", accounts: "secret" }, 1))
      .toThrow("Invalid CC-Router status payload");
  });
});

describe("selectCriticalUtilization", () => {
  it("selects the highest valid current utilization", () => {
    const account = {
      windows: [
        { utilization: 0.2 },
        { utilization: 0.59 },
        { utilization: 0.4 },
      ],
    } as AccountStatus;

    expect(selectCriticalUtilization(account)).toBe(0.59);
  });

  it("returns null when no meaningful utilization exists", () => {
    expect(selectCriticalUtilization({ windows: [] } as unknown as AccountStatus)).toBeNull();
  });
});
