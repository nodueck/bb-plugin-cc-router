import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const providerSummarySchema = z.object({
  configured: z.boolean(),
  accounts: z.number().finite().nonnegative(),
  healthy: z.number().finite().nonnegative(),
  enabled: z.number().finite().nonnegative(),
}).strict();

const allowanceWindowSchema = z.object({
  id: z.string().max(128),
  label: z.string().max(128),
  utilization: z.number().finite().min(0).max(1),
  resetAtMs: z.number().finite().nonnegative().nullable(),
  windowMinutes: z.number().finite().positive().nullable(),
}).strict();

const creditsSchema = z.object({
  hasCredits: z.boolean(),
  unlimited: z.boolean(),
  balance: z.string().max(128).nullable(),
  resetCreditsAvailable: z.number().finite().nonnegative().nullable(),
}).strict();

export const accountStatusSchema = z.object({
  id: z.string().max(128),
  provider: z.enum(["anthropic", "openai", "xai"]),
  enabled: z.boolean(),
  healthy: z.boolean(),
  busy: z.boolean(),
  inFlightRequests: z.number().finite().nonnegative(),
  activeSessions: z.number().finite().nonnegative(),
  requestCount: z.number().finite().nonnegative(),
  errorCount: z.number().finite().nonnegative(),
  lastUsedMs: z.number().finite().nonnegative(),
  cooldownUntilMs: z.number().finite().nonnegative(),
  plan: z.string().max(128).nullable(),
  allowanceUpdatedAt: z.number().finite().nonnegative().nullable(),
  allowanceFreshness: z.enum(["fresh", "stale", "unavailable"]).nullable(),
  windows: z.array(allowanceWindowSchema).max(8),
  credits: creditsSchema.nullable(),
}).strict();

export const routerStatusSnapshotSchema = z.object({
  status: z.enum(["ok", "degraded", "unknown"]),
  version: z.string().max(128),
  mode: z.string().max(128),
  target: z.string().max(128),
  uptimeSeconds: z.number().finite().nonnegative(),
  totalRequests: z.number().finite().nonnegative(),
  totalErrors: z.number().finite().nonnegative(),
  fetchedAt: z.number().finite().nonnegative(),
  stale: z.boolean(),
  staleReason: z.string().max(200).nullable(),
  providers: z.object({
    anthropic: providerSummarySchema,
    openai: providerSummarySchema,
    xai: providerSummarySchema,
  }).strict(),
  accounts: z.array(accountStatusSchema).max(100),
}).strict();

export const threadAccountResultSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("mapped"),
    account: accountStatusSchema,
    bindingLastSeenAt: z.number().finite().nonnegative(),
  }).strict(),
  z.object({
    state: z.literal("stale"),
    account: accountStatusSchema,
    bindingLastSeenAt: z.number().finite().nonnegative(),
    reason: z.string().max(200),
  }).strict(),
  z.object({
    state: z.literal("last-used"),
    account: accountStatusSchema,
    lastSeenAt: z.number().finite().nonnegative(),
  }).strict(),
  z.object({
    state: z.literal("unmapped"),
    reason: z.enum([
      "unsupported-provider",
      "missing-identity",
      "not-bound",
      "account-missing",
    ]),
  }).strict(),
  z.object({
    state: z.literal("unavailable"),
    message: z.string().max(200),
  }).strict(),
]);

export const rpcContract = defineRpcContract({
  getStatus: {
    input: z.object({
      force: z.boolean().optional(),
    }).strict(),
    output: routerStatusSnapshotSchema,
  },
  getThreadAccount: {
    input: z.object({
      threadId: z.string().min(1).max(128),
      force: z.boolean().optional(),
    }).strict(),
    output: threadAccountResultSchema,
  },
});
