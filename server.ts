import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import { CcRouterClient } from "./src/cc-router-client";
import { StatusCache } from "./src/status-cache";
import {
  mapBbProvider,
  resolveThreadAccount,
  type LastUsedBinding,
  type ThreadAccountDependencies,
} from "./src/thread-account";

const LAST_USED_PREFIX = "last-used:";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const client = new CcRouterClient();
  const statusCache = new StatusCache(signal => client.getStatus(signal));
  const threadDependencies: ThreadAccountDependencies = {
    threads: {
      get: async ({ threadId }) => {
        const thread = await bb.sdk.threads.get({ threadId });
        return { providerId: thread.providerId };
      },
      events: {
        list: async args => {
          const events = await bb.sdk.threads.events.list(args);
          return events.map(event => ({
            type: event.type,
            data: event.data,
          }));
        },
      },
    },
    statusCache,
    client,
    lastUsed: {
      get: threadId => bb.storage.kv.get<LastUsedBinding>(LAST_USED_PREFIX + threadId),
      set: (threadId, binding) => bb.storage.kv.set(LAST_USED_PREFIX + threadId, binding),
    },
  };

  bb.rpc.register(rpcContract, {
    getStatus: ({ force }) => statusCache.get({ force: force === true }),
    getThreadAccount: input => resolveThreadAccount(input, threadDependencies),
  });

  // A turn has just made requests, so its binding is fresh. Resolving it here
  // records the account even for threads nobody has open, such as automations.
  const recordTurnAccount = async ({ thread }: { thread: { id: string; providerId: string } }) => {
    if (!mapBbProvider(thread.providerId)) return;
    const result = await resolveThreadAccount({ threadId: thread.id }, threadDependencies);
    if (result.state === "unavailable") {
      bb.log.warn(`could not record turn account for ${thread.id}: ${result.message}`);
    }
  };
  bb.events.on("thread.idle", recordTurnAccount);
  bb.events.on("thread.failed", recordTurnAccount);
  bb.events.on("thread.deleted", ({ thread }) => bb.storage.kv.delete(LAST_USED_PREFIX + thread.id));

  bb.log.info("loaded");
  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}

export { rpcContract } from "./contract";
export type {
  AccountStatus,
  AllowanceWindow,
  RouterStatusSnapshot,
} from "./src/status-model";
export type { ThreadAccountResult } from "./src/thread-account";
