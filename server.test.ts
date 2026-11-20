import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function health() {
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
    accounts: [{
      id: "main-account",
      provider: "anthropic_subscription",
      enabled: true,
      healthy: true,
      busy: false,
      inFlightRequests: 0,
      activeSessions: 1,
      requestCount: 20,
      errorCount: 2,
      lastUsedMs: 100,
      cooldownUntilMs: 0,
      rateLimits: {
        usage: {
          fiveHour: { utilization: 0.2, resetAt: 1_800_000_000 },
          sevenDay: { utilization: 0.59, resetAt: 1_800_100_000 },
          fetchedAt: 200,
          fetchStatus: "fresh",
        },
      },
    }],
  };
}

function setup() {
  const fetch = vi.fn(async (input: string, _init?: RequestInit) => {
    if (input.endsWith("/cc-router/health")) {
      return new Response(JSON.stringify(health()), { status: 200 });
    }
    if (input.endsWith("/cc-router/sessions/resolve")) {
      return new Response(JSON.stringify({
        accountId: "main-account",
        provider: "anthropic",
        lastSeenAt: 150,
      }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);

  const thread = makeThreadResponse({
    id: "thread-1",
    providerId: "claude-code",
  });
  const get = vi.fn(async () => thread);
  const eventsList = vi.fn(async () => [{
    id: "event-1",
    threadId: "thread-1",
    seq: 1,
    createdAt: 100,
    scope: { kind: "thread" as const },
    type: "thread/identity" as const,
    data: { providerThreadId: "native-secret" },
  }]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "cc-router",
    sdk: {
      threads: {
        get,
        events: { list: eventsList },
      },
    },
  });
  return { bb, harness, fetch, get, eventsList };
}

describe("CC-Router status backend", () => {
  it("registers bounded status RPC with cache and force-refresh semantics", async () => {
    const { bb, harness, fetch } = setup();
    await plugin(bb);

    const first = await harness.behavior.callRpc("getStatus", {});
    const cached = await harness.behavior.callRpc("getStatus", {});
    const forced = await harness.behavior.callRpc("getStatus", { force: true });

    expect(first).toMatchObject({
      status: "ok",
      version: "0.13.0",
      stale: false,
      accounts: [{ id: "main-account", provider: "anthropic" }],
    });
    expect(cached).toEqual(first);
    expect(forced).toMatchObject({ status: "ok" });
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith("/cc-router/health")))
      .toHaveLength(2);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/cc-router/refresh")))
      .toBe(false);
  });

  it("resolves the current thread account without returning the provider session ID", async () => {
    const { bb, harness, get, eventsList, fetch } = setup();
    await plugin(bb);

    const result = await harness.behavior.callRpc("getThreadAccount", {
      threadId: "thread-1",
    });

    expect(result).toMatchObject({
      state: "mapped",
      account: {
        id: "main-account",
        windows: [
          { label: "5 hours", utilization: 0.2 },
          { label: "7 days", utilization: 0.59 },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("native-secret");
    expect(get).toHaveBeenCalledWith({ threadId: "thread-1" });
    expect(eventsList).toHaveBeenCalledWith({
      threadId: "thread-1",
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    });
    const resolveCall = fetch.mock.calls.find(([url]) => (
      String(url).endsWith("/cc-router/sessions/resolve")
    ));
    expect(resolveCall?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        provider: "anthropic",
        sessionId: "native-secret",
      }),
    });
  });

  it("records the account at turn end and shows it after the binding expires", async () => {
    const { bb, harness, fetch } = setup();
    await plugin(bb);

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-1", providerId: "claude-code" }),
      lastAssistantText: null,
    });
    fetch.mockImplementation(async (input: string, _init?: RequestInit) => {
      if (input.endsWith("/cc-router/health")) {
        return new Response(JSON.stringify(health()), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "Session binding not found" }), { status: 404 });
    });

    const result = await harness.behavior.callRpc("getThreadAccount", {
      threadId: "thread-1",
    });

    expect(result).toMatchObject({
      state: "last-used",
      account: { id: "main-account" },
      lastSeenAt: 150,
    });
  });

  it("ignores turn ends of providers CC-Router does not route", async () => {
    const { bb, harness, get } = setup();
    await plugin(bb);

    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thread-2", providerId: "pi" }),
      lastAssistantText: null,
    });

    expect(get).not.toHaveBeenCalled();
  });

  it("returns an unavailable state when exact mapping is unsupported", async () => {
    const { bb, harness, fetch } = setup();
    fetch.mockImplementation(async (input: string, _init?: RequestInit) => {
      if (input.endsWith("/cc-router/health")) {
        return new Response(JSON.stringify(health()), { status: 200 });
      }
      return new Response("Cannot POST /cc-router/sessions/resolve", { status: 404 });
    });
    await plugin(bb);

    const result = await harness.behavior.callRpc("getThreadAccount", {
      threadId: "thread-1",
    });

    expect(result).toEqual({
      state: "unavailable",
      message: "CC-Router session endpoint unavailable",
    });
  });
});
