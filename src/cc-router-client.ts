import { parseRouterStatus, type RouterStatusSnapshot } from "./status-model";

const DEFAULT_BASE_URL = "http://127.0.0.1:3456";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_ACCOUNT_ID_LENGTH = 128;

export type SessionResolveProvider = "anthropic" | "openai";

export interface SessionResolveInput {
  sessionId: string;
  provider: SessionResolveProvider;
}

export interface SessionResolveResult {
  accountId: string;
  provider: SessionResolveProvider;
  lastSeenAt: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CcRouterClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export class CcRouterClient {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: CcRouterClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async getStatus(signal?: AbortSignal): Promise<RouterStatusSnapshot> {
    const response = await this.request("/cc-router/health", {
      method: "GET",
      headers: { accept: "application/json" },
    }, signal);
    if (!response.ok) {
      throw new Error(`CC-Router health request failed (${response.status})`);
    }

    return parseRouterStatus(await parseJson(response, "status"), this.now());
  }

  async resolveSession(
    input: SessionResolveInput,
    signal?: AbortSignal,
  ): Promise<SessionResolveResult | null> {
    const response = await this.request("/cc-router/sessions/resolve", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    }, signal);

    if (response.status === 404) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("CC-Router session endpoint unavailable");
      }
      if (
        body
        && typeof body === "object"
        && !Array.isArray(body)
        && (body as Record<string, unknown>).error === "Session binding not found"
      ) {
        return null;
      }
      throw new Error("CC-Router session endpoint unavailable");
    }
    if (!response.ok) {
      throw new Error(`CC-Router session request failed (${response.status})`);
    }

    return parseSessionResolveResult(await parseJson(response, "session"), input.provider);
  }

  private async request(
    path: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal?.aborted) onExternalAbort();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("CC-Router request timed out", "TimeoutError"));
    }, this.timeoutMs);

    try {
      return await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

function parseSessionResolveResult(
  value: unknown,
  expectedProvider: SessionResolveProvider,
): SessionResolveResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid CC-Router session response");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.accountId !== "string"
    || result.accountId.length === 0
    || result.accountId.length > MAX_ACCOUNT_ID_LENGTH
    || result.provider !== expectedProvider
    || typeof result.lastSeenAt !== "number"
    || !Number.isFinite(result.lastSeenAt)
    || result.lastSeenAt < 0
  ) {
    throw new Error("Invalid CC-Router session response");
  }

  return {
    accountId: result.accountId,
    provider: expectedProvider,
    lastSeenAt: result.lastSeenAt,
  };
}

async function parseJson(response: Response, kind: "status" | "session"): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Invalid CC-Router ${kind} response`);
  }
}
