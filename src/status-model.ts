const MAX_ACCOUNTS = 100;
const MAX_WINDOWS_PER_ACCOUNT = 8;
const MAX_STRING_LENGTH = 128;

export type AccountProvider = "anthropic" | "openai" | "xai";
export type AllowanceFreshness = "fresh" | "stale" | "unavailable" | null;

export interface AllowanceWindow {
  id: string;
  label: string;
  utilization: number;
  resetAtMs: number | null;
  windowMinutes: number | null;
}

export interface AccountCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
  resetCreditsAvailable: number | null;
}

export interface AccountStatus {
  id: string;
  provider: AccountProvider;
  enabled: boolean;
  healthy: boolean;
  busy: boolean;
  inFlightRequests: number;
  activeSessions: number;
  requestCount: number;
  errorCount: number;
  lastUsedMs: number;
  cooldownUntilMs: number;
  plan: string | null;
  allowanceUpdatedAt: number | null;
  allowanceFreshness: AllowanceFreshness;
  windows: AllowanceWindow[];
  credits: AccountCredits | null;
}

export interface ProviderSummary {
  configured: boolean;
  accounts: number;
  healthy: number;
  enabled: number;
}

export interface RouterStatusSnapshot {
  status: "ok" | "degraded" | "unknown";
  version: string;
  mode: string;
  target: string;
  uptimeSeconds: number;
  totalRequests: number;
  totalErrors: number;
  fetchedAt: number;
  stale: boolean;
  staleReason: string | null;
  providers: Record<AccountProvider, ProviderSummary>;
  accounts: AccountStatus[];
}

export function parseRouterStatus(value: unknown, fetchedAt = Date.now()): RouterStatusSnapshot {
  const root = record(value);
  if (!root || !Array.isArray(root.accounts)) {
    throw new Error("Invalid CC-Router status payload");
  }

  const operational = record(root.operational);
  const providerRoot = record(operational?.providers);
  const accounts = root.accounts
    .slice(0, MAX_ACCOUNTS)
    .map(parseAccount)
    .filter((account): account is AccountStatus => account !== null);

  return {
    status: routerStatus(root.status),
    version: boundedString(root.version),
    mode: boundedString(root.mode),
    target: boundedString(root.target),
    uptimeSeconds: nonNegativeNumber(root.uptime),
    totalRequests: nonNegativeNumber(root.totalRequests),
    totalErrors: nonNegativeNumber(root.totalErrors),
    fetchedAt: finiteTimestamp(fetchedAt) ?? Date.now(),
    stale: false,
    staleReason: null,
    providers: {
      anthropic: parseProviderSummary(providerRoot?.anthropic),
      openai: parseProviderSummary(providerRoot?.openai),
      xai: parseProviderSummary(providerRoot?.xai),
    },
    accounts,
  };
}

export function selectCriticalUtilization(account: AccountStatus): number | null {
  if (account.windows.length === 0) return null;
  let highest: number | null = null;
  for (const window of account.windows) {
    if (!Number.isFinite(window.utilization)) continue;
    highest = highest === null
      ? window.utilization
      : Math.max(highest, window.utilization);
  }
  return highest;
}

function parseAccount(value: unknown): AccountStatus | null {
  const account = record(value);
  if (!account) return null;

  const provider = parseProvider(account.provider);
  const id = boundedString(account.id);
  if (!provider || id === "") return null;

  const parsed = provider === "anthropic"
    ? parseAnthropicAllowance(account)
    : provider === "openai"
      ? parseOpenAIAllowance(account)
      : emptyAllowance();

  return {
    id,
    provider,
    enabled: booleanValue(account.enabled),
    healthy: booleanValue(account.healthy),
    busy: booleanValue(account.busy),
    inFlightRequests: nonNegativeNumber(account.inFlightRequests),
    activeSessions: nonNegativeNumber(account.activeSessions),
    requestCount: nonNegativeNumber(account.requestCount),
    errorCount: nonNegativeNumber(account.errorCount),
    lastUsedMs: nonNegativeNumber(account.lastUsedMs),
    cooldownUntilMs: Math.max(
      nonNegativeNumber(account.cooldownUntilMs),
      nonNegativeNumber(account.globalCooldownUntilMs),
    ),
    ...parsed,
  };
}

function parseAnthropicAllowance(account: Record<string, unknown>): ParsedAllowance {
  const rateLimits = record(account.rateLimits);
  const usage = record(rateLimits?.usage);
  const detailedFiveHour = parseWindow(usage?.fiveHour, "five-hour", "5 hours", 300);
  const detailedSevenDay = parseWindow(usage?.sevenDay, "seven-day", "7 days", 10_080);
  const fallbackFiveHour = parseLegacyWindow(
    rateLimits?.fiveHourUtil,
    rateLimits?.fiveHourReset,
    "five-hour",
    "5 hours",
    300,
  );
  const fallbackSevenDay = parseLegacyWindow(
    rateLimits?.sevenDayUtil,
    rateLimits?.sevenDayReset,
    "seven-day",
    "7 days",
    10_080,
  );

  return {
    plan: nullableBoundedString(rateLimits?.plan),
    allowanceUpdatedAt: finiteTimestamp(usage?.fetchedAt)
      ?? finiteTimestamp(rateLimits?.lastUpdated),
    allowanceFreshness: parseFreshness(usage?.fetchStatus),
    windows: [
      detailedFiveHour ?? fallbackFiveHour,
      detailedSevenDay ?? fallbackSevenDay,
    ].filter((window): window is AllowanceWindow => window !== null),
    credits: null,
  };
}

function parseOpenAIAllowance(account: Record<string, unknown>): ParsedAllowance {
  const rateLimits = record(account.codexRateLimits);
  const buckets = Array.isArray(rateLimits?.buckets)
    ? rateLimits.buckets.slice(0, MAX_WINDOWS_PER_ACCOUNT)
    : [];
  const windows: AllowanceWindow[] = [];

  for (const [bucketIndex, candidate] of buckets.entries()) {
    const bucket = record(candidate);
    if (!bucket) continue;
    const limitId = boundedString(bucket.limitId) || `bucket-${bucketIndex + 1}`;
    const label = boundedString(bucket.label) || limitId;
    for (const position of ["primary", "secondary"] as const) {
      if (windows.length >= MAX_WINDOWS_PER_ACCOUNT) break;
      const window = parseCodexWindow(
        bucket[position],
        `${limitId}-${position}`,
        label,
        position,
      );
      if (window) windows.push(window);
    }
  }

  const credits = record(rateLimits?.credits);
  const resetCredits = record(rateLimits?.resetCredits);
  return {
    plan: nullableBoundedString(rateLimits?.plan),
    allowanceUpdatedAt: finiteTimestamp(rateLimits?.lastUpdated),
    allowanceFreshness: rateLimits ? "fresh" : null,
    windows,
    credits: credits
      ? {
        hasCredits: booleanValue(credits.hasCredits),
        unlimited: booleanValue(credits.unlimited),
        balance: nullableBoundedString(credits.balance),
        resetCreditsAvailable: nullableNonNegativeNumber(resetCredits?.available),
      }
      : null,
  };
}

function parseWindow(
  value: unknown,
  id: string,
  label: string,
  windowMinutes: number,
): AllowanceWindow | null {
  const window = record(value);
  if (!window) return null;
  const utilization = utilizationValue(window.utilization);
  if (utilization === null) return null;
  return {
    id,
    label,
    utilization,
    resetAtMs: epochSecondsToMs(window.resetAt),
    windowMinutes,
  };
}

function parseLegacyWindow(
  utilizationCandidate: unknown,
  resetCandidate: unknown,
  id: string,
  label: string,
  windowMinutes: number,
): AllowanceWindow | null {
  const utilization = utilizationValue(utilizationCandidate);
  if (utilization === null) return null;
  return {
    id,
    label,
    utilization,
    resetAtMs: epochSecondsToMs(resetCandidate),
    windowMinutes,
  };
}

function parseCodexWindow(
  value: unknown,
  id: string,
  bucketLabel: string,
  position: "primary" | "secondary",
): AllowanceWindow | null {
  const window = record(value);
  if (!window) return null;
  const utilization = utilizationValue(window.utilization);
  if (utilization === null) return null;
  const windowMinutes = positiveNumber(window.windowMinutes);
  return {
    id: boundedString(id),
    label: windowLabel(windowMinutes, bucketLabel, position),
    utilization,
    resetAtMs: epochSecondsToMs(window.resetAt),
    windowMinutes,
  };
}

function windowLabel(
  minutes: number | null,
  bucketLabel: string,
  position: "primary" | "secondary",
): string {
  if (minutes === 300) return "5 hours";
  if (minutes === 10_080) return "7 days";
  if (minutes !== null && minutes % 1_440 === 0) {
    return `${minutes / 1_440} days`;
  }
  if (minutes !== null && minutes % 60 === 0) {
    return `${minutes / 60} hours`;
  }
  if (minutes !== null) return `${minutes} minutes`;
  return boundedString(`${bucketLabel} ${position}`);
}

function parseProvider(value: unknown): AccountProvider | null {
  if (value === "anthropic_subscription") return "anthropic";
  if (value === "openai_subscription") return "openai";
  if (value === "xai_subscription") return "xai";
  return null;
}

function parseProviderSummary(value: unknown): ProviderSummary {
  const summary = record(value);
  return {
    configured: booleanValue(summary?.configured),
    accounts: nonNegativeNumber(summary?.accounts),
    healthy: nonNegativeNumber(summary?.healthy),
    enabled: nonNegativeNumber(summary?.enabled),
  };
}

function emptyAllowance(): ParsedAllowance {
  return {
    plan: null,
    allowanceUpdatedAt: null,
    allowanceFreshness: null,
    windows: [],
    credits: null,
  };
}

interface ParsedAllowance {
  plan: string | null;
  allowanceUpdatedAt: number | null;
  allowanceFreshness: AllowanceFreshness;
  windows: AllowanceWindow[];
  credits: AccountCredits | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function routerStatus(value: unknown): RouterStatusSnapshot["status"] {
  if (value === "ok" || value === "degraded") return value;
  return "unknown";
}

function boundedString(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, MAX_STRING_LENGTH)
    : "";
}

function nullableBoundedString(value: unknown): string | null {
  const text = boundedString(value);
  return text === "" ? null : text;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function nullableNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function utilizationValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : null;
}

function epochSecondsToMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value * 1_000
    : null;
}

function parseFreshness(value: unknown): AllowanceFreshness {
  return value === "fresh" || value === "stale" || value === "unavailable"
    ? value
    : null;
}
