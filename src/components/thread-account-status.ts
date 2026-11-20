import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract";
import type { AccountStatus } from "../status-model";
import { selectCriticalUtilization } from "../status-model";
import { dateTime, percent } from "./format";

type Result =
  | { state: "mapped"; account: AccountStatus; bindingLastSeenAt: number }
  | { state: "stale"; account: AccountStatus; bindingLastSeenAt: number; reason: string }
  | { state: "last-used"; account: AccountStatus; lastSeenAt: number }
  | { state: "unmapped"; reason: "unsupported-provider" | "missing-identity" | "not-bound" | "account-missing" }
  | { state: "unavailable"; message: string };

const POLL_MS = 300_000;
const RETRY_MS = 5_000;

function nextPollDelay(result: Result): number {
  // Until a turn rebinds the session, a quick retry picks up the live account.
  if (result.state === "unavailable" || result.state === "last-used") return RETRY_MS;
  if (
    result.state === "unmapped"
    && result.reason !== "unsupported-provider"
  ) {
    return RETRY_MS;
  }
  return POLL_MS;
}

function mappedText(account: AccountStatus, suffix: string | null): string {
  const utilization = selectCriticalUtilization(account);
  const usage = utilization === null ? "—" : percent(utilization);
  return `${account.id} · ${usage}${suffix ? ` · ${suffix}` : ""}`;
}

export interface Display {
  label: string;
  detail: string;
  muted?: boolean;
  account?: AccountStatus;
  notes?: string[];
}

function notes(result: Result): string[] {
  if (result.state === "stale") return [`Stale: ${result.reason}`];
  if (result.state === "last-used") {
    return [
      `Last used: ${dateTime(result.lastSeenAt)}`,
      "The router binding expired; the next turn may use another account",
    ];
  }
  return [];
}

function details(result: Result): string {
  if (result.state === "unmapped") {
    if (result.reason === "not-bound") {
      return "No active CC-Router binding: the session has been idle for over an hour or has never been routed";
    }
    if (result.reason === "missing-identity") {
      return "This session has not sent a request yet";
    }
    return `No exact CC-Router session binding (${result.reason})`;
  }
  if (result.state === "unavailable") return result.message;
  const lines = result.account.windows.map(window => `${window.label}: ${percent(window.utilization)}`);
  lines.push(...notes(result));
  return lines.join("\n") || "Allowance details unavailable";
}

function unmappedLabel(reason: Extract<Result, { state: "unmapped" }>["reason"]): string {
  if (reason === "not-bound") return "CC-Router: idle";
  if (reason === "missing-identity") return "CC-Router: no session yet";
  return "CC-Router: not mapped";
}

export function toDisplay(result: Result | null, error: string | null): Display {
  if (error) return { label: "CC-Router: unavailable", detail: error };
  if (!result) return { label: "CC-Router…", detail: "Loading CC-Router session mapping" };
  if (result.state === "unmapped") return { label: unmappedLabel(result.reason), detail: details(result) };
  if (result.state === "unavailable") return { label: "CC-Router: unavailable", detail: details(result) };
  if (result.state === "last-used") {
    return {
      label: mappedText(result.account, "last"),
      detail: details(result),
      muted: true,
      account: result.account,
      notes: notes(result),
    };
  }
  return {
    label: mappedText(result.account, result.state === "stale" ? "stale" : null),
    detail: details(result),
    account: result.account,
    notes: notes(result),
  };
}

/**
 * The CC-Router account of every thread whose header is on screen. Polls
 * quickly while any of them waits for a turn to bind its session.
 */
export function useThreadAccounts(threadIds: readonly string[]): ReadonlyMap<string, Display> {
  const rpc = useRpc<typeof rpcContract>();
  const [displays, setDisplays] = useState<ReadonlyMap<string, Display>>(new Map());
  const key = threadIds.join("\n");

  useEffect(() => {
    const ids = key === "" ? [] : key.split("\n");
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      const loaded = await Promise.all(ids.map(async threadId => {
        try {
          const result = await rpc.call("getThreadAccount", { threadId });
          return { threadId, display: toDisplay(result, null), delay: nextPollDelay(result) };
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : "CC-Router unavailable";
          return { threadId, display: toDisplay(null, message), delay: RETRY_MS };
        }
      }));
      if (!active) return;
      setDisplays(new Map(loaded.map(entry => [entry.threadId, entry.display])));
      timer = window.setTimeout(() => void load(), Math.min(POLL_MS, ...loaded.map(entry => entry.delay)));
    };
    if (ids.length > 0) void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [rpc, key]);

  return displays;
}
