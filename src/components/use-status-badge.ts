import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { summarizeStatus, type SummaryTone } from "./status-summary";
import { useRouterStatus } from "./use-router-status";

const BADGE_TONES: Record<SummaryTone, ExperimentalBadge["tone"]> = {
  good: "neutral",
  warn: "warning",
  bad: "critical",
};

/** Sidebar badge: how many accounts can take requests right now. */
export function useStatusBadge(): ExperimentalBadge | null {
  const { status, error } = useRouterStatus();
  if (!status) {
    return error ? { text: "offline", tone: "critical", label: `CC-Router unavailable: ${error}` } : null;
  }
  const summary = summarizeStatus(status);
  return {
    text: `${summary.ready}/${summary.total}`,
    tone: BADGE_TONES[summary.tone],
    label: `CC-Router: ${summary.ready} of ${summary.total} accounts can take requests${status.stale ? " (stale)" : ""}`,
  };
}
