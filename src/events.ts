import { SpectryHttpError, type Transport } from "./transport.js";
import type { Logger, SpectryEvent } from "./types.js";

/** The API refuses more than this in one request. */
const MAX_BATCH = 100;

/**
 * Buffers custom events and ships them in batches.
 *
 * `logEvent()` is deliberately synchronous and never throws. It is called from
 * a request handler on someone's checkout path, and an analytics call has no
 * business adding latency there, let alone an exception.
 *
 * The queue is bounded. An unbounded one turns an API outage into the host
 * process running out of memory, so past the ceiling the oldest events are
 * dropped and the loss is logged once.
 */
export class EventQueue {
  private queue: SpectryEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private closed = false;
  private droppedSinceLastWarning = 0;

  constructor(
    private readonly transport: Transport,
    private readonly logger: Logger,
    private readonly onError: (error: Error, context: { operation: string }) => void,
    private readonly options: {
      batchSize: number;
      flushInterval: number;
      maxQueued: number;
      timeout: number;
    },
  ) {}

  get size(): number {
    return this.queue.length;
  }

  /** Queue an event. Never throws; never waits on the network. */
  enqueue(event: SpectryEvent): void {
    if (this.closed) {
      this.logger.warn(`event "${event.name}" dropped: client is closed`);
      return;
    }

    if (this.queue.length >= this.options.maxQueued) {
      // Drop the oldest: during a backlog the newest events are the ones still
      // worth having, and a queue that only grows will take the process down.
      this.queue.shift();
      this.droppedSinceLastWarning++;
      if (this.droppedSinceLastWarning === 1 || this.droppedSinceLastWarning % 1000 === 0) {
        this.logger.warn(
          `event queue is full (${this.options.maxQueued}); dropped ${this.droppedSinceLastWarning} event(s)`,
        );
      }
    }

    this.queue.push(event);

    if (this.queue.length >= this.options.batchSize) {
      void this.flush().catch(() => {});
      return;
    }

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.options.flushInterval <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, this.options.flushInterval);
    this.timer.unref?.();
  }

  /**
   * Send everything queued.
   *
   * Await this before a serverless handler returns or a process exits —
   * otherwise the buffer dies with it.
   */
  async flush(): Promise<void> {
    if (this.flushing) {
      // Let the in-flight flush finish, then drain whatever arrived meanwhile.
      await this.flushing;
      if (this.queue.length === 0) return;
    }

    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, Math.min(this.options.batchSize, MAX_BATCH));

      try {
        await this.transport.request({
          method: "POST",
          path: "/events",
          body: { events: batch },
          timeout: this.options.timeout,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // A rejected batch is malformed or unauthorised; re-queueing it would
        // retry the same failure forever and block every event behind it.
        // Anything else is worth one more attempt on the next flush.
        if (error instanceof SpectryHttpError && error.isPermanent) {
          this.logger.error(
            `dropped ${batch.length} event(s): ${err.message}`,
          );
        } else {
          this.requeue(batch);
          this.logger.warn(`failed to send ${batch.length} event(s), will retry: ${err.message}`);
        }

        this.onError(err, { operation: "flush" });
        return;
      }
    }
  }

  /** Put a failed batch back at the front, respecting the ceiling. */
  private requeue(batch: SpectryEvent[]): void {
    const room = Math.max(0, this.options.maxQueued - this.queue.length);
    if (room === 0) {
      this.droppedSinceLastWarning += batch.length;
      return;
    }
    const keep = batch.slice(-room);
    this.droppedSinceLastWarning += batch.length - keep.length;
    this.queue.unshift(...keep);
  }

  /** Flush what is left, then refuse new events. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush().catch(() => {});
  }
}
