import { ConfigStore } from "./config-store.js";
import { EventQueue } from "./events.js";
import { resolveLogger } from "./logger.js";
import { ScopedSpectry } from "./scoped.js";
import { Transport } from "./transport.js";
import type {
  InitOptions,
  Logger,
  SpectryClientOptions,
  SpectryConfig,
  UserContext,
} from "./types.js";

export const SDK_VERSION = "0.1.0";

const DEFAULTS = {
  apiHost: "https://api.spectry.io",
  refreshInterval: 60_000,
  timeout: 3_000,
  eventFlushInterval: 5_000,
  eventBatchSize: 25,
  maxQueuedEvents: 1_000,
};

/**
 * The long-lived client. Create **one per process**, at boot.
 *
 * It owns the cached flag and experiment definitions, the timer that refreshes
 * them, and the queue that ships events. Per-request work goes through
 * `createScopedInstance()`, which is cheap and synchronous.
 *
 * ```ts
 * const client = new SpectryClient({ siteId, secretKey });
 * await client.init({ timeout: 1000 });
 *
 * app.use((req, _res, next) => {
 *   req.spectry = client.createScopedInstance({ attributes: { id: req.user.id } });
 *   next();
 * });
 * ```
 *
 * Creating a client per request would refetch the config every time and defeat
 * the caching entirely — the thing that makes `isOn()` free.
 */
export class SpectryClient {
  private readonly store: ConfigStore;
  private readonly queue: EventQueue;
  private readonly logger: Logger;
  private readonly refreshInterval: number;
  private readonly timeout: number;
  private initPromise: Promise<boolean> | null = null;
  private closed = false;

  constructor(options: SpectryClientOptions) {
    if (!options?.siteId) throw new Error("SpectryClient requires a `siteId`");
    if (!options.secretKey) throw new Error("SpectryClient requires a `secretKey`");

    this.logger = resolveLogger(options.logger);
    this.timeout = options.timeout ?? DEFAULTS.timeout;
    this.refreshInterval = options.refreshInterval ?? DEFAULTS.refreshInterval;

    const onError =
      options.onError ??
      (() => {
        /* errors are logged; the hook is for reporting them elsewhere */
      });

    const transport = new Transport({
      apiHost: options.apiHost ?? DEFAULTS.apiHost,
      siteId: options.siteId,
      secretKey: options.secretKey,
      version: SDK_VERSION,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

    this.store = new ConfigStore(transport, this.logger, onError, this.timeout);
    this.queue = new EventQueue(transport, this.logger, onError, {
      batchSize: options.eventBatchSize ?? DEFAULTS.eventBatchSize,
      flushInterval: options.eventFlushInterval ?? DEFAULTS.eventFlushInterval,
      maxQueued: options.maxQueuedEvents ?? DEFAULTS.maxQueuedEvents,
      timeout: this.timeout,
    });
  }

  /**
   * Load the config and start refreshing it.
   *
   * Resolves `true` when the config is in hand and `false` when the first fetch
   * failed. It does **not** throw by default: an SDK that stops your server
   * from booting because our API blinked is worse than one that serves
   * fallbacks for a minute. Polling continues either way, so a client that
   * starts degraded recovers on its own.
   *
   * Pass `{ throwOnFailure: true }` if you would rather fail fast.
   */
  async init(options: InitOptions = {}): Promise<boolean> {
    if (this.closed) throw new Error("SpectryClient has been closed");
    // Calling init twice should not mean fetching twice.
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit(options);
    return this.initPromise;
  }

  private async doInit(options: InitOptions): Promise<boolean> {
    try {
      await this.store.fetch(options.timeout ?? this.timeout);
      this.logger.debug("initialised", this.store.status());
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.throwOnFailure) throw err;
      this.logger.warn(
        `could not load config at init; features will use their fallbacks until a refresh succeeds: ${err.message}`,
      );
      return false;
    } finally {
      // Start polling even after a failed first fetch — that is precisely the
      // case that needs to recover without anyone restarting the process.
      this.store.start(this.refreshInterval);
    }
  }

  /** Has a config been loaded? */
  get ready(): boolean {
    return this.store.ready;
  }

  /**
   * Cache and refresh state, for a health check or a debug endpoint.
   *
   * `version` is the *config* version — the ETag the cache is holding — and is
   * the one that tells you whether a flag change has landed. The SDK's own
   * version is `sdkVersion`; the two are separate fields because a status
   * object that reported only one of them was reporting the less useful one.
   */
  getStatus() {
    return { ...this.store.status(), queuedEvents: this.queue.size, sdkVersion: SDK_VERSION };
  }

  /** The cached config, or `null`. Treat it as read-only. */
  getConfig(): SpectryConfig | null {
    return this.store.get();
  }

  /**
   * Bind the config to one user.
   *
   * Cheap — it copies no definitions and makes no network call — so per request
   * is exactly right.
   */
  createScopedInstance(context: UserContext = {}): ScopedSpectry {
    return new ScopedSpectry(
      context,
      () => this.store.get(),
      this.queue,
      this.logger,
    );
  }

  /**
   * Refresh the config now, out of band. Rarely needed — the poll handles it —
   * but useful right after a deliberate flag change, or from a webhook.
   */
  async refresh(): Promise<boolean> {
    try {
      await this.store.fetch();
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(`manual refresh failed: ${err.message}`);
      return false;
    }
  }

  /** Send every queued event now. */
  async flush(): Promise<void> {
    await this.queue.flush();
  }

  /**
   * Stop polling and flush what is queued.
   *
   * Call it on shutdown, and at the end of a serverless invocation — the queue
   * lives in memory and dies with the process otherwise.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.store.close();
    await this.queue.close();
  }
}
