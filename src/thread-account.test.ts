import { describe, expect, it, vi } from "vitest";
import {
  mapBbProvider,
  resolveThreadAccount,
  type LastUsedBinding,
  type ThreadAccountDependencies,
} from "./thread-account";
import type { RouterStatusSnapshot } from "./status-model";

function snapshot(stale = false): RouterStatusSnapshot {
  return {
    status: "ok",
    version: "0.13.0",
    mode: "standalone",
    target: "local",
    uptimeSeconds: 1,
    totalRequests: 2,
    totalErrors: 0,
    fetchedAt: 100,
    stale,
    staleReason: stale ? "connection refused" : null,
    providers: {
      anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
      openai: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
      xai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
    },
    accounts: [{
      id: "main-account",
      provider: "anthropic",
      enabled: true,
      healthy: true,
      busy: false,
      inFlightRequests: 1,
      activeSessions: 2,
      requestCount: 3,
      errorCount: 0,
      lastUsedMs: 90,
      cooldownUntilMs: 0,
      plan: null,
      allowanceUpdatedAt: 80,
      allowanceFreshness: "fresh",
      windows: [{
        id: "five-hour",
        label: "5 hours",
        utilization: 0.59,
        resetAtMs: 1_000,
        windowMinutes: 300,
      }],
      credits: null,
    }],
  };
}

function dependencies(
  providerId = "claude-code",
  providerThreadId: string | null = "native-secret",
  status = snapshot(),
): ThreadAccountDependencies {
  return {
    threads: {
      get: vi.fn(async () => ({ providerId })),
      events: {
        list: vi.fn(async () => providerThreadId === null ? [] : [{
          type: "thread/identity",
          data: { providerThreadId },
        }]),
      },
    },
    statusCache: {
      get: vi.fn(async () => status),
    },
    client: {
      resolveSession: vi.fn(async () => ({
        accountId: "main-account",
        provider: "anthropic" as const,
        lastSeenAt: 75,
      })),
    },
    lastUsed: memoryLastUsed(),
  };
}

function memoryLastUsed(initial: Record<string, LastUsedBinding> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (threadId: string) => entries.get(threadId)),
    set: vi.fn(async (threadId: string, binding: LastUsedBinding) => {
      entries.set(threadId, binding);
    }),
  };
}

describe("mapBbProvider", () => {
  it("maps only the two CC-Router-backed BB providers", () => {
    expect(mapBbProvider("claude-code")).toBe("anthropic");
    expect(mapBbProvider("codex")).toBe("openai");
    expect(mapBbProvider("pi")).toBeNull();
  });
});

describe("resolveThreadAccount", () => {
  it("reads the latest identity event and resolves a Claude session exactly", async () => {
    const deps = dependencies();

    const result = await resolveThreadAccount({
      threadId: "thread-1",
      force: true,
    }, deps);

    expect(deps.threads.get).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(deps.threads.events.list).toHaveBeenCalledWith({
      threadId: "thread-1",
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    });
    expect(deps.client.resolveSession).toHaveBeenCalledWith({
      provider: "anthropic",
      sessionId: "native-secret",
    });
    expect(deps.statusCache.get).toHaveBeenCalledWith({ force: true });
    expect(result).toEqual({
      state: "mapped",
      account: snapshot().accounts[0],
      bindingLastSeenAt: 75,
    });
    expect(JSON.stringify(result)).not.toContain("native-secret");
  });

  it("maps Codex to OpenAI", async () => {
    const deps = dependencies("codex");
    vi.mocked(deps.client.resolveSession).mockResolvedValue({
      accountId: "main-account",
      provider: "openai",
      lastSeenAt: 75,
    });

    await resolveThreadAccount({ threadId: "thread-1" }, deps);

    expect(deps.client.resolveSession).toHaveBeenCalledWith({
      provider: "openai",
      sessionId: "native-secret",
    });
  });

  it("does not contact CC-Router for unsupported providers", async () => {
    const deps = dependencies("pi");

    const result = await resolveThreadAccount({ threadId: "thread-1" }, deps);

    expect(result).toEqual({ state: "unmapped", reason: "unsupported-provider" });
    expect(deps.threads.events.list).not.toHaveBeenCalled();
    expect(deps.client.resolveSession).not.toHaveBeenCalled();
    expect(deps.statusCache.get).not.toHaveBeenCalled();
  });

  it("does not contact CC-Router when no identity exists yet", async () => {
    const deps = dependencies("claude-code", null);

    const result = await resolveThreadAccount({ threadId: "thread-1" }, deps);

    expect(result).toEqual({ state: "unmapped", reason: "missing-identity" });
    expect(deps.client.resolveSession).not.toHaveBeenCalled();
    expect(deps.statusCache.get).not.toHaveBeenCalled();
  });

  it("returns unmapped for an unknown binding or missing account", async () => {
    const unbound = dependencies();
    vi.mocked(unbound.client.resolveSession).mockResolvedValue(null);
    await expect(resolveThreadAccount({ threadId: "thread-1" }, unbound))
      .resolves.toEqual({ state: "unmapped", reason: "not-bound" });

    const missing = dependencies();
    vi.mocked(missing.client.resolveSession).mockResolvedValue({
      accountId: "removed-account",
      provider: "anthropic",
      lastSeenAt: 75,
    });
    await expect(resolveThreadAccount({ threadId: "thread-1" }, missing))
      .resolves.toEqual({ state: "unmapped", reason: "account-missing" });
  });

  it("remembers the account of an exact binding for the thread", async () => {
    const deps = dependencies();

    await resolveThreadAccount({ threadId: "thread-1" }, deps);

    expect(deps.lastUsed.set).toHaveBeenCalledWith("thread-1", {
      accountId: "main-account",
      provider: "anthropic",
      lastSeenAt: 75,
    });
  });

  it("falls back to the last used account once the router binding expired", async () => {
    const deps = dependencies();
    deps.lastUsed = memoryLastUsed({
      "thread-1": { accountId: "main-account", provider: "anthropic", lastSeenAt: 60 },
    });
    vi.mocked(deps.client.resolveSession).mockResolvedValue(null);

    const result = await resolveThreadAccount({ threadId: "thread-1" }, deps);

    expect(result).toEqual({
      state: "last-used",
      account: snapshot().accounts[0],
      lastSeenAt: 60,
    });
    expect(deps.lastUsed.set).not.toHaveBeenCalled();
  });

  it("stays unbound when the last used account no longer exists", async () => {
    const deps = dependencies();
    deps.lastUsed = memoryLastUsed({
      "thread-1": { accountId: "removed-account", provider: "anthropic", lastSeenAt: 60 },
    });
    vi.mocked(deps.client.resolveSession).mockResolvedValue(null);

    await expect(resolveThreadAccount({ threadId: "thread-1" }, deps))
      .resolves.toEqual({ state: "unmapped", reason: "not-bound" });
  });

  it("returns a distinct stale state when status refresh fell back", async () => {
    const deps = dependencies("claude-code", "native-secret", snapshot(true));

    const result = await resolveThreadAccount({ threadId: "thread-1" }, deps);

    expect(result).toMatchObject({
      state: "stale",
      account: { id: "main-account" },
      bindingLastSeenAt: 75,
      reason: "connection refused",
    });
  });

  it("returns a bounded unavailable state instead of leaking backend errors", async () => {
    const deps = dependencies();
    vi.mocked(deps.statusCache.get).mockRejectedValue(new Error(`offline ${"x".repeat(500)}`));

    const result = await resolveThreadAccount({ threadId: "thread-1" }, deps);

    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable") {
      expect(result.message.length).toBeLessThanOrEqual(200);
    }
  });
});
