import { afterEach, describe, expect, it, vi } from "vitest";
import { CcRouterClient } from "./cc-router-client";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function minimalHealth() {
  return {
    status: "ok",
    version: "0.13.0",
    mode: "standalone",
    target: "https://api.anthropic.com",
    uptime: 1,
    totalRequests: 2,
    totalErrors: 0,
    accounts: [],
  };
}

describe("CcRouterClient", () => {
  it("fetches and parses status only from the fixed loopback health URL", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(minimalHealth()), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = new CcRouterClient({ fetch, now: () => 123 });

    const status = await client.getStatus();

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3456/cc-router/health",
      expect.objectContaining({ method: "GET" }),
    );
    expect(status.fetchedAt).toBe(123);
  });

  it("posts one provider/session pair and treats 404 as an unmapped session", async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: "Session binding not found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    ));
    const client = new CcRouterClient({ fetch });

    const result = await client.resolveSession({
      provider: "anthropic",
      sessionId: "native-secret-session",
    });

    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3456/cc-router/sessions/resolve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider: "anthropic",
          sessionId: "native-secret-session",
        }),
      }),
    );
  });

  it("treats an old router's generic 404 as endpoint unavailable", async () => {
    const fetch = vi.fn(async () => new Response("Cannot POST /cc-router/sessions/resolve", {
      status: 404,
      headers: { "content-type": "text/plain" },
    }));
    const client = new CcRouterClient({ fetch });

    await expect(client.resolveSession({
      provider: "anthropic",
      sessionId: "native-secret-session",
    })).rejects.toThrow("CC-Router session endpoint unavailable");
  });

  it("parses a safe resolve response and rejects incompatible payloads", async () => {
    const responses = [
      new Response(JSON.stringify({
        accountId: "main-account",
        provider: "anthropic",
        lastSeenAt: 123,
        additive: true,
      }), { status: 200 }),
      new Response(JSON.stringify({
        accountId: "main-account",
        provider: "openai",
        lastSeenAt: 123,
      }), { status: 200 }),
      new Response(JSON.stringify({
        accountId: "x".repeat(300),
        provider: "anthropic",
        lastSeenAt: 123,
      }), { status: 200 }),
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    const client = new CcRouterClient({ fetch });

    await expect(client.resolveSession({
      provider: "anthropic",
      sessionId: "session-a",
    })).resolves.toEqual({
      accountId: "main-account",
      provider: "anthropic",
      lastSeenAt: 123,
    });
    await expect(client.resolveSession({
      provider: "anthropic",
      sessionId: "session-a",
    })).rejects.toThrow("Invalid CC-Router session response");
    await expect(client.resolveSession({
      provider: "anthropic",
      sessionId: "session-a",
    })).rejects.toThrow("Invalid CC-Router session response");
  });

  it("rejects malformed health payloads and non-success status codes", async () => {
    const responses = [
      new Response(JSON.stringify({ status: "ok", accounts: "not-an-array" }), { status: 200 }),
      new Response("down", { status: 503 }),
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    const client = new CcRouterClient({ fetch });

    await expect(client.getStatus()).rejects.toThrow("Invalid CC-Router status payload");
    await expect(client.getStatus()).rejects.toThrow("CC-Router health request failed (503)");
  });

  it("aborts requests at the configured timeout", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      });
    }));
    const client = new CcRouterClient({ fetch, timeoutMs: 50 });

    const request = client.getStatus();
    const rejection = expect(request).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("honors an external abort signal", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const client = new CcRouterClient({ fetch });
    const controller = new AbortController();

    const request = client.getStatus(controller.signal);
    controller.abort();

    await expect(request).rejects.toThrow();
  });
});
