// Pacing and retry for Google API calls. Over the per-user quota, Gmail and
// Drive answer 403 "Quota exceeded …" / rateLimitExceeded or 429; without a
// pause every remaining call fails within seconds (the first Gmail run lost
// 4,039 of 4,297 messages that way). One limiter is shared by all workers of
// a run: a limit hit by any of them pauses all, slows the pace, and the call
// is retried instead of counted as failed.

export function isRateLimitError(err: unknown): boolean {
  const e = err as {
    code?: number | string;
    status?: number;
    message?: string;
    errors?: { reason?: string }[];
    response?: { status?: number };
  };
  if (!e || typeof e !== "object") return false;
  const status = Number(e.response?.status ?? e.status ?? e.code);
  if (status === 429) return true;
  if (status !== 403) return false;
  const reasons = (e.errors ?? []).map((x) => x.reason ?? "");
  return (
    reasons.some((r) => /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(r)) ||
    /quota exceeded|rate limit exceeded/i.test(e.message ?? "")
  );
}

export interface RateLimiterOptions {
  // Gap between calls across all workers; doubles on each new limit hit.
  minIntervalMs: number;
  maxIntervalMs: number;
  // Retries per call after a limit hit; the pause doubles each time.
  retries: number;
  basePauseMs: number;
  maxPauseMs: number;
  // Called once per pause (not once per worker that hit it).
  onLimited?: (pauseMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface CallRunner {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

// For tests and callers that need no pacing.
export const unlimited: CallRunner = { run: (fn) => fn() };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter implements CallRunner {
  private intervalMs: number;
  private nextAt = 0;
  private pausedUntil = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.intervalMs = opts.minIntervalMs;
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  private async slot(): Promise<void> {
    for (;;) {
      const t = this.now();
      const wait = Math.max(this.pausedUntil, this.nextAt) - t;
      if (wait <= 0) {
        this.nextAt = t + this.intervalMs;
        return;
      }
      await this.sleep(wait);
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= this.opts.retries) throw err;
        const t = this.now();
        const pause = Math.min(this.opts.maxPauseMs, this.opts.basePauseMs * 2 ** attempt);
        // Workers whose calls were already in flight hit the same limit;
        // only the first of them slows the pace and reports the pause.
        if (t >= this.pausedUntil) {
          this.intervalMs = Math.min(this.opts.maxIntervalMs, Math.max(1, this.intervalMs) * 2);
          this.opts.onLimited?.(pause);
        }
        this.pausedUntil = Math.max(this.pausedUntil, t + pause);
      }
    }
  }
}
