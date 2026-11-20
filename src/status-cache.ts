import type { RouterStatusSnapshot } from "./status-model";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export interface StatusCacheGetOptions {
  force?: boolean;
  signal?: AbortSignal;
}

export interface StatusCacheOptions {
  now?: () => number;
  ttlMs?: number;
}

export type StatusLoader = (signal?: AbortSignal) => Promise<RouterStatusSnapshot>;

export class StatusCache {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private cached: RouterStatusSnapshot | null = null;
  private inFlight: Promise<RouterStatusSnapshot> | null = null;

  constructor(
    private readonly load: StatusLoader,
    options: StatusCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  get(options: StatusCacheGetOptions = {}): Promise<RouterStatusSnapshot> {
    const force = options.force === true;
    if (!force && this.cached && this.now() - this.cached.fetchedAt < this.ttlMs) {
      return Promise.resolve(this.cached);
    }
    if (this.inFlight) return this.inFlight;

    const request = this.refresh(options.signal);
    this.inFlight = request;
    void request.finally(() => {
      if (this.inFlight === request) this.inFlight = null;
    }).catch(() => undefined);
    return request;
  }

  private async refresh(signal?: AbortSignal): Promise<RouterStatusSnapshot> {
    try {
      const snapshot = await this.load(signal);
      this.cached = snapshot;
      return snapshot;
    } catch (error) {
      if (!this.cached) throw error;
      return {
        ...this.cached,
        stale: true,
        staleReason: boundedErrorMessage(error),
      };
    }
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
