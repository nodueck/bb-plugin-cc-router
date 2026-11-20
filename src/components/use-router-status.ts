import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contract";
import type { RouterStatusSnapshot } from "../status-model";

const POLL_MS = 300_000;

/** Router status, refreshed every five minutes while mounted. */
export function useRouterStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<RouterStatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    try {
      const next = await rpc.call("getStatus", force ? { force: true } : {});
      setStatus(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load CC-Router status");
    } finally {
      if (force) setRefreshing(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  return { status, error, refreshing, refresh: () => load(true) };
}
