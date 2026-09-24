import { SpectryHttpError, type Transport } from "./transport.js";
import type { Logger, SpectryConfig } from "./types.js";

/**
 * Holds the cached config and keeps it fresh.
 *
 * Three rules shape this:
 *
 * 1. **Serve stale over nothing.** A refresh that fails keeps the last good
 *    config. Dropping it would switch every feature to its fallback across the
 *    whole fleet at once — an outage in our API becoming an outage in theirs.
 * 2. **One fetch at a time.** Concurrent refreshes share a single in-flight
 *    promise, so a burst of requests during boot makes one call, not hundreds.
 * 3. **Never hold the process open.** The poll timer is `unref()`'d, so a
 *    script that finishes its work still exits.
 */
export class ConfigStore {
  private config: SpectryConfig | null = null;
  private etag: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<SpectryConfig | null> | null = null;
  private stopped = false;

  private lastUpdatedAt: number | null = null;
  private lastAttemptAt: number | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly transport: Transport,
    private readonly logger: Logger,
    private readonly onError: (error: Error, context: { operation: string }) => void,
    private readonly defaultTimeout: number,
  ) {}

  get(): SpectryConfig | null {
    return this.config;
  }

  get ready(): boolean {
    return this.config !== null;
  }

  status() {
    return {
      ready: this.ready,
      version: this.config?.version ?? null,
      flagCount: this.config?.flags.length ?? 0,
      experimentCount: this.config?.experiments.length ?? 0,
      lastUpdatedAt: this.lastUpdatedAt,
      lastAttemptAt: this.lastAttemptAt,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Fetch the config. Returns the cached copy on a 304, and rethrows on
   * failure — deciding whether a failure matters is the caller's job, because
   * it does on `init()` and does not on a background poll.
   */
  async fetch(timeout = this.defaultTimeout): Promise<SpectryConfig | null> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.doFetch(timeout).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doFetch(timeout: number): Promise<SpectryConfig | null> {
    this.lastAttemptAt = Date.now();
    try {
      const response = await this.transport.request<SpectryConfig>({
        method: "GET",
        path: "/config",
        timeout,
        // A poll that finds nothing new costs a 304 and no body.
        ...(this.etag ? { headers: { "if-none-match": this.etag } } : {}),
      });

      this.consecutiveFailures = 0;

      if (response.status === 304 || !response.data) {
        this.logger.debug("config unchanged");
        return this.config;
      }

      this.config = response.data;
      this.etag = response.etag ?? response.data.version ?? null;
      this.lastUpdatedAt = Date.now();
      this.logger.debug("config updated", {
        version: this.config.version,
        flags: this.config.flags?.length ?? 0,
      });

      return this.config;
    } catch (error) {
      this.consecutiveFailures++;
      throw error;
    }
  }

  /** Begin polling. Safe to call twice; the second call is a no-op. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0 || this.stopped) return;

    this.timer = setInterval(() => {
      void this.fetch().catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));

        // A bad key will not fix itself, and repeating it every minute for the
        // life of the process just buries the one message that matters.
        if (error instanceof SpectryHttpError && error.isPermanent) {
          this.logger.error(
            `config refresh rejected (${error.status}) — check siteId and secretKey. Polling stopped.`,
          );
          this.stop();
        } else if (this.consecutiveFailures === 1) {
          this.logger.warn(
            `config refresh failed, serving the last known config: ${err.message}`,
          );
        }

        this.onError(err, { operation: "refresh" });
      });
    }, intervalMs);

    // Don't keep a short-lived script alive just because we're polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close(): void {
    this.stopped = true;
    this.stop();
  }
}
