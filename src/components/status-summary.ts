import type { AccountStatus, RouterStatusSnapshot } from "../status-model";
import { selectCriticalUtilization } from "../status-model";

export type SummaryTone = "good" | "warn" | "bad";

export interface StatusSummary {
  /** Accounts that can take a request right now. */
  ready: number;
  total: number;
  tone: SummaryTone;
}

/** Whether CC-Router can route a request to this account right now. */
export function isAccountReady(account: AccountStatus, now = Date.now()): boolean {
  const utilization = selectCriticalUtilization(account);
  return account.enabled
    && account.healthy
    && account.cooldownUntilMs <= now
    && (utilization === null || utilization < 1);
}

export function summarizeStatus(status: RouterStatusSnapshot, now = Date.now()): StatusSummary {
  const ready = status.accounts.filter(account => isAccountReady(account, now)).length;
  const total = status.accounts.length;
  let tone: SummaryTone = "good";
  if (status.status !== "ok" || ready === 0) tone = "bad";
  else if (status.stale || ready < total) tone = "warn";
  return { ready, total, tone };
}
