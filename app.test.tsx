// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";

const account = {
  id: "main-account",
  provider: "anthropic" as const,
  enabled: true,
  healthy: true,
  busy: false,
  inFlightRequests: 1,
  activeSessions: 2,
  requestCount: 20,
  errorCount: 2,
  lastUsedMs: 100,
  cooldownUntilMs: 0,
  plan: "Max",
  allowanceUpdatedAt: 200,
  allowanceFreshness: "fresh" as const,
  windows: [
    { id: "five-hour", label: "5 hours", utilization: 0.2, resetAtMs: 1_800_000_000_000, windowMinutes: 300 },
    { id: "seven-day", label: "7 days", utilization: 0.59, resetAtMs: 1_800_100_000_000, windowMinutes: 10_080 },
  ],
  credits: null,
};

const status = {
  status: "ok" as const,
  version: "0.13.0",
  mode: "standalone",
  target: "https://api.anthropic.com",
  uptimeSeconds: 3_661,
  totalRequests: 20,
  totalErrors: 2,
  fetchedAt: 1_700_000_000_000,
  stale: false,
  staleReason: null,
  providers: {
    anthropic: { configured: true, accounts: 1, healthy: 1, enabled: 1 },
    openai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
    xai: { configured: false, accounts: 0, healthy: 0, enabled: 0 },
  },
  accounts: [account],
};

type CapturedApp = Awaited<ReturnType<typeof loadPluginApp>>;

/** Renders the header thread action for thread-1 the way BB evaluates it. */
function headerButton(app: CapturedApp) {
  const registration = app.threadActions[0];
  return function HeaderButton() {
    const data = registration.useData!({ threadIds: ["thread-1"] });
    const navigate = useBbNavigate();
    const action = registration.item({
      thread: { id: "thread-1" } as never,
      data,
      sdk: undefined as never,
      navigate,
      experimental_panel: undefined as never,
    });
    if (!action) return <span>no header button</span>;
    return (
      <button type="button" title={action.detail} onClick={() => void action.run({ requestRename: () => {} })}>
        {action.label}
      </button>
    );
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CC-Router Status app", () => {
  it("registers the sidebar page and an official header button", async () => {
    const app = await loadPluginApp(() => import("./app"));

    expect(app.navPanels).toMatchObject([{
      id: "cc-router-page",
      title: "CC-Router",
      icon: "ChartColumn",
      path: "status",
    }]);
    expect(app.navPanels[0].experimental_useBadge).toBeTypeOf("function");
    expect(app.threadPanelActions).toEqual([]);
    expect(app.newThreadPanelActions).toEqual([]);
    expect(app.threadActions).toMatchObject([{
      id: "cc-router-thread-account",
      placement: "header",
      icon: "ChartColumn",
    }]);
    expect(app.threadHeaderActions).toEqual([]);
    expect(app.threadContextSegments).toEqual([]);
  });

  it("renders loading, mapped allowance details, and stops five-minute polling", async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const pending = new Promise(resolvePromise => { resolve = resolvePromise; });
    const app = await loadPluginApp(() => import("./app"));
    const view = renderSlot<object, typeof rpcContract>(
      { component: headerButton(app) },
      {},
      { rpc: { getThreadAccount: async () => pending as never, getStatus: async () => status } },
    );

    expect(screen.getByText("no header button")).toBeTruthy();
    await act(async () => {
      resolve({ state: "mapped", account, bindingLastSeenAt: 150 });
      await Promise.resolve();
    });
    expect(screen.getByText("main-account · 59%")).toBeTruthy();
    const control = screen.getByRole("button", { name: "main-account · 59%" });
    expect(control.getAttribute("title")).toContain("5 hours: 20%");
    expect(control.getAttribute("title")).toContain("7 days: 59%");

    expect(view.rpcCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(view.rpcCalls).toHaveLength(2);
    view.unmount();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(view.rpcCalls).toHaveLength(2);
  });

  it("retries an unbound session quickly after the first routed request", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const app = await loadPluginApp(() => import("./app"));
    const view = renderSlot(
      { component: headerButton(app) },
      {},
      {
        rpc: {
          getThreadAccount: async () => {
            calls++;
            return calls === 1
              ? { state: "unmapped" as const, reason: "not-bound" as const }
              : { state: "mapped" as const, account, bindingLastSeenAt: 150 };
          },
          getStatus: async () => status,
        },
      },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("CC-Router: idle")).toBeTruthy();
    expect(view.rpcCalls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(screen.getByText("main-account · 59%")).toBeTruthy();
    expect(view.rpcCalls).toHaveLength(2);
  });

  it.each([
    [{ state: "unmapped", reason: "not-bound" }, "CC-Router: idle", "No active CC-Router binding"],
    [{ state: "unmapped", reason: "missing-identity" }, "CC-Router: no session yet", "has not sent a request"],
    [{ state: "unmapped", reason: "account-missing" }, "CC-Router: not mapped", "account-missing"],
    [{ state: "last-used", account, lastSeenAt: 150 }, "main-account · 59% · last", "next turn may use another account"],
    [{ state: "unavailable", message: "CC-Router session endpoint unavailable" }, "CC-Router: unavailable", "session endpoint unavailable"],
    [{ state: "stale", account, bindingLastSeenAt: 150, reason: "health request failed" }, "main-account · 59% · stale", "health request failed"],
  ])("renders header state %#", async (result, label, detail) => {
    const app = await loadPluginApp(() => import("./app"));
    renderSlot(
      { component: headerButton(app) },
      {},
      { rpc: { getThreadAccount: async () => result as never, getStatus: async () => status } },
    );
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).getAttribute("title")).toContain(detail);
  });

  it("renders router and account details and force-refreshes manually", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const view = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      { rpc: { getStatus: async () => status, getThreadAccount: async () => ({ state: "mapped", account, bindingLastSeenAt: 150 }) } },
    );

    expect(await screen.findByText("Automatic refresh every 5 minutes")).toBeTruthy();
    for (const text of ["Healthy", "0.13.0", "standalone", "1h 1m", "20", "2", "main-account", "Anthropic", "5 hours", "20%", "7 days", "59%", "2 active sessions", "1 in flight", "Enabled"]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText(/recent request/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh CC-Router status" }));
    await waitFor(() => expect(view.rpcCalls).toContainEqual({ method: "getStatus", input: { force: true } }));
  });

  it("opens the CC-Router page from the header button", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const view = renderSlot(
      { component: headerButton(app) },
      {},
      { rpc: { getThreadAccount: async () => ({ state: "mapped", account, bindingLastSeenAt: 150 }), getStatus: async () => status } },
    );

    fireEvent.click(await screen.findByText("main-account · 59%"));

    expect(view.navigateCalls).toContainEqual(expect.objectContaining({ method: "toPluginPanel", path: "status" }));
  });

  it("summarizes ready accounts in the sidebar badge", async () => {
    const cooling = { ...account, id: "backup-account", cooldownUntilMs: Date.now() + 60_000 };
    const app = await loadPluginApp(() => import("./app"));
    const useBadge = app.navPanels[0].experimental_useBadge!;
    function BadgeProbe() {
      return <output>{JSON.stringify(useBadge())}</output>;
    }
    renderSlot(
      { component: BadgeProbe },
      {},
      { rpc: { getStatus: async () => ({ ...status, accounts: [account, cooling] }) } },
    );

    await waitFor(() => expect(JSON.parse(screen.getByRole("status").textContent ?? "null")).toEqual({
      text: "1/2",
      tone: "warning",
      label: "CC-Router: 1 of 2 accounts can take requests",
    }));
  });

  it("shows stale last-update context and cooldown badges", async () => {
    const staleStatus = {
      ...status,
      stale: true,
      staleReason: "connection refused",
      accounts: [{ ...account, healthy: false, cooldownUntilMs: Date.now() + 60_000 }],
    };
    const app = await loadPluginApp(() => import("./app"));
    renderSlot(
      app.navPanels[0],
      { subPath: "" },
      { rpc: { getStatus: async () => staleStatus, getThreadAccount: async () => ({ state: "unmapped", reason: "not-bound" }) } },
    );

    expect(await screen.findByText("Stale")).toBeTruthy();
    expect(screen.getByText(/connection refused/i)).toBeTruthy();
    expect(screen.getByText("Unhealthy")).toBeTruthy();
    expect(screen.getByText("Cooldown")).toBeTruthy();
    expect(screen.getByText(/Last successful update/i)).toBeTruthy();
  });
});
