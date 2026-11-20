import { describe, expect, it, vi } from "vitest";
import { StatusCache } from "./status-cache";
import type { RouterStatusSnapshot } from "./status-model";

function snapshot(fetchedAt: number): RouterStatusSnapshot {
  return {
    status: "ok",
    version: "0.13.0",
    mode: "standalone",
    target: "local",
    uptimeSeconds: 1,
    totalRequests: 2,
    totalErrors: 0,
    fetchedAt,
    stale: false,
    staleReason: null,
    providers: {
      anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
      openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
      xai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
    },
    accounts: [],
  };
}

describe("StatusCache", () => {
  it("serves one snapshot for five minutes and refreshes after expiry", async () => {
    let now = 0;
    const load = vi.fn(async () => snapshot(now));
    const cache = new StatusCache(load, { now: () => now });

    expect(await cache.get()).toEqual(snapshot(0));
    now = 299_999;
    expect(await cache.get()).toEqual(snapshot(0));
    expect(load).toHaveBeenCalledTimes(1);

    now = 300_000;
    expect(await cache.get()).toEqual(snapshot(300_000));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bypasses freshness on a forced refresh", async () => {
    let now = 0;
    const load = vi.fn(async () => snapshot(now));
    const cache = new StatusCache(load, { now: () => now });

    await cache.get();
    now = 100;
    expect(await cache.get({ force: true })).toEqual(snapshot(100));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight fetch across concurrent callers", async () => {
    let resolve!: (value: RouterStatusSnapshot) => void;
    const load = vi.fn(() => new Promise<RouterStatusSnapshot>((done) => {
      resolve = done;
    }));
    const cache = new StatusCache(load);

    const first = cache.get();
    const second = cache.get({ force: true });
    resolve(snapshot(1));

    await expect(first).resolves.toEqual(snapshot(1));
    await expect(second).resolves.toEqual(snapshot(1));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("preserves the last successful snapshot as stale after refresh failure", async () => {
    let now = 0;
    const load = vi.fn()
      .mockResolvedValueOnce(snapshot(0))
      .mockRejectedValueOnce(new Error("connection refused"));
    const cache = new StatusCache(load, { now: () => now });

    await cache.get();
    now = 300_000;
    const stale = await cache.get();

    expect(stale).toMatchObject({
      fetchedAt: 0,
      stale: true,
      staleReason: "connection refused",
    });
  });

  it("throws when the first load fails", async () => {
    const cache = new StatusCache(async () => {
      throw new Error("offline");
    });

    await expect(cache.get()).rejects.toThrow("offline");
  });
});
