import type { AccountStatus } from "../status-model";
import { AllowanceBars } from "./allowance-bars";
import { dateTime, duration, providerName } from "./format";
import { useRouterStatus } from "./use-router-status";

/** Route of the CC-Router page under `/plugins/cc-router/`. */
export const STATUS_PAGE_PATH = "status";

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "good" | "warn" | "bad" | "neutral" }) {
  return <span className={`cc-badge cc-badge-${tone}`}>{children}</span>;
}

function AccountCard({ account }: { account: AccountStatus }) {
  const coolingDown = account.cooldownUntilMs > Date.now();
  return (
    <article className="cc-account">
      <div className="cc-row">
        <div>
          <h3>{account.id}</h3>
          <div className="cc-muted">{providerName(account.provider)}{account.plan ? ` · ${account.plan}` : ""}</div>
        </div>
        <div className="cc-badges">
          <Badge tone={account.enabled ? "good" : "neutral"}>{account.enabled ? "Enabled" : "Disabled"}</Badge>
          <Badge tone={account.healthy ? "good" : "bad"}>{account.healthy ? "Healthy" : "Unhealthy"}</Badge>
          {account.busy ? <Badge tone="warn">Busy</Badge> : null}
          {coolingDown ? <Badge tone="warn">Cooldown</Badge> : null}
        </div>
      </div>
      <div className="cc-account-stats">
        <span>{account.activeSessions} active sessions</span>
        <span>{account.inFlightRequests} in flight</span>
        <span>{account.requestCount} requests</span>
        <span>{account.errorCount} errors</span>
      </div>
      <AllowanceBars windows={account.windows} />
      {account.allowanceFreshness ? <div className="cc-muted cc-small">Allowance: {account.allowanceFreshness}</div> : null}
      {coolingDown ? <div className="cc-muted cc-small">Cooldown until {dateTime(account.cooldownUntilMs)}</div> : null}
      {account.credits ? (
        <div className="cc-credits">
          Credits: {account.credits.unlimited ? "Unlimited" : account.credits.balance ?? (account.credits.hasCredits ? "Available" : "Unavailable")}
        </div>
      ) : null}
    </article>
  );
}

export function StatusPanel() {
  const { status, error, refreshing, refresh } = useRouterStatus();

  return (
    <section className="cc-panel" aria-label="CC-Router status panel">
      <header className="cc-panel-header">
        <div className="cc-muted">Automatic refresh every 5 minutes</div>
        <button
          type="button"
          className="cc-refresh"
          aria-label="Refresh CC-Router status"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <div className="cc-scroll">
        {error && !status ? <p role="alert" className="cc-error">{error}</p> : null}
        {!status && !error ? <p className="cc-muted">Loading CC-Router status…</p> : null}
        {status ? (
          <>
            <div className="cc-summary-row">
            <div className="cc-overview">
              <div className="cc-row">
                <strong>{status.status === "ok" ? "Healthy" : status.status === "degraded" ? "Degraded" : "Unknown"}</strong>
                {status.stale ? <Badge tone="warn">Stale</Badge> : <Badge tone="good">Live</Badge>}
              </div>
              <dl className="cc-grid">
                <div><dt>Version</dt><dd>{status.version}</dd></div>
                <div><dt>Mode</dt><dd>{status.mode}</dd></div>
                <div><dt>Uptime</dt><dd>{duration(status.uptimeSeconds)}</dd></div>
                <div><dt>Requests</dt><dd>{status.totalRequests}</dd></div>
                <div><dt>Errors</dt><dd>{status.totalErrors}</dd></div>
              </dl>
              <div className="cc-muted cc-small">
                {status.stale ? "Last successful update" : "Last update"}: {dateTime(status.fetchedAt)}
                {status.staleReason ? ` · ${status.staleReason}` : ""}
              </div>
            </div>
            <div className="cc-providers" aria-label="Provider summary">
              {Object.entries(status.providers).map(([provider, summary]) => (
                <div className="cc-provider" key={provider}>
                  <strong>{providerName(provider)}</strong>
                  <span>{summary.healthy}/{summary.accounts} healthy · {summary.enabled} enabled</span>
                </div>
              ))}
            </div>
            </div>
            <div className="cc-account-list">
              {status.accounts.map(item => <AccountCard account={item} key={`${item.provider}:${item.id}`} />)}
              {status.accounts.length === 0 ? <p className="cc-muted">No accounts configured</p> : null}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
