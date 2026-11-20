import type {
  CcRouterClient,
  SessionResolveProvider,
  SessionResolveResult,
} from "./cc-router-client";
import type { StatusCache } from "./status-cache";
import type { AccountStatus, RouterStatusSnapshot } from "./status-model";

export type ThreadAccountResult =
  | {
    state: "mapped";
    account: AccountStatus;
    bindingLastSeenAt: number;
  }
  | {
    state: "stale";
    account: AccountStatus;
    bindingLastSeenAt: number;
    reason: string;
  }
  | {
    state: "last-used";
    account: AccountStatus;
    lastSeenAt: number;
  }
  | {
    state: "unmapped";
    reason: "unsupported-provider" | "missing-identity" | "not-bound" | "account-missing";
  }
  | {
    state: "unavailable";
    message: string;
  };

/** The account CC-Router last bound to a thread, kept after the binding expires. */
export interface LastUsedBinding {
  accountId: string;
  provider: SessionResolveProvider;
  lastSeenAt: number;
}

export interface ThreadAccountInput {
  threadId: string;
  force?: boolean;
}

export interface ThreadAccountDependencies {
  threads: {
    get(args: { threadId: string }): Promise<{ providerId: string }>;
    events: {
      list(args: {
        threadId: string;
        types: readonly ["thread/identity"];
        order: "desc";
        limit: "1";
      }): Promise<Array<{ type: string; data: unknown }>>;
    };
  };
  statusCache: Pick<StatusCache, "get">;
  client: Pick<CcRouterClient, "resolveSession">;
  lastUsed: {
    get(threadId: string): Promise<LastUsedBinding | undefined>;
    set(threadId: string, binding: LastUsedBinding): Promise<void>;
  };
}

export function mapBbProvider(providerId: string): SessionResolveProvider | null {
  if (providerId === "claude-code") return "anthropic";
  if (providerId === "codex") return "openai";
  return null;
}

export async function resolveThreadAccount(
  input: ThreadAccountInput,
  dependencies: ThreadAccountDependencies,
): Promise<ThreadAccountResult> {
  try {
    const thread = await dependencies.threads.get({ threadId: input.threadId });
    const provider = mapBbProvider(thread.providerId);
    if (!provider) {
      return { state: "unmapped", reason: "unsupported-provider" };
    }

    const events = await dependencies.threads.events.list({
      threadId: input.threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    });
    const sessionId = identitySessionId(events[0]);
    if (!sessionId) {
      return { state: "unmapped", reason: "missing-identity" };
    }

    const binding = await dependencies.client.resolveSession({ provider, sessionId });
    if (!binding) {
      // CC-Router drops bindings after an hour without requests.
      const lastUsed = await dependencies.lastUsed.get(input.threadId);
      if (!lastUsed || lastUsed.provider !== provider) {
        return { state: "unmapped", reason: "not-bound" };
      }
      const status = await dependencies.statusCache.get({ force: input.force === true });
      const account = findAccount(status, lastUsed);
      return account
        ? { state: "last-used", account, lastSeenAt: lastUsed.lastSeenAt }
        : { state: "unmapped", reason: "not-bound" };
    }

    await dependencies.lastUsed.set(input.threadId, {
      accountId: binding.accountId,
      provider: binding.provider,
      lastSeenAt: binding.lastSeenAt,
    });
    const status = await dependencies.statusCache.get({ force: input.force === true });
    return joinBinding(binding, status);
  } catch (error) {
    return {
      state: "unavailable",
      message: boundedMessage(error),
    };
  }
}

function identitySessionId(event: { type: string; data: unknown } | undefined): string | null {
  if (!event || event.type !== "thread/identity") return null;
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const providerThreadId = (event.data as Record<string, unknown>).providerThreadId;
  return typeof providerThreadId === "string" && providerThreadId.length > 0
    ? providerThreadId
    : null;
}

function joinBinding(
  binding: SessionResolveResult,
  status: RouterStatusSnapshot,
): ThreadAccountResult {
  const account = findAccount(status, binding);
  if (!account) {
    return { state: "unmapped", reason: "account-missing" };
  }
  if (status.stale) {
    return {
      state: "stale",
      account,
      bindingLastSeenAt: binding.lastSeenAt,
      reason: status.staleReason ?? "Status refresh failed",
    };
  }
  return {
    state: "mapped",
    account,
    bindingLastSeenAt: binding.lastSeenAt,
  };
}

function findAccount(
  status: RouterStatusSnapshot,
  binding: { accountId: string; provider: SessionResolveProvider },
): AccountStatus | undefined {
  return status.accounts.find(candidate => (
    candidate.id === binding.accountId
    && candidate.provider === binding.provider
  ));
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
