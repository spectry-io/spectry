import type { FetchLike } from "./types.js";

export class SpectryHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Spectry API responded ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "SpectryHttpError";
    this.status = status;
    this.body = body;
    // A 401/403 means the secret key is missing, wrong, revoked or lacks the
    // scope for this route — a configuration mistake no retry will fix.
    // Callers branch on this rather than on the message.
    Object.setPrototypeOf(this, SpectryHttpError.prototype);
  }

  /** Retrying will not help: the request itself is wrong. */
  get isPermanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeout: number;
  signal?: AbortSignal;
}

export interface TransportResponse<T> {
  status: number;
  data: T | null;
  etag: string | null;
}

/**
 * The SDK's whole network surface: JSON in, JSON out, always with a timeout.
 *
 * `fetch` alone has no timeout, so a half-open connection would hang a config
 * refresh — or an `init()` the caller is awaiting during boot — indefinitely.
 * Every request here is raced against an `AbortController`.
 */
export class Transport {
  private readonly apiHost: string;
  private readonly siteId: string;
  private readonly secretKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;

  constructor(opts: {
    apiHost: string;
    siteId: string;
    secretKey: string;
    fetch?: FetchLike;
    version: string;
  }) {
    this.apiHost = opts.apiHost.replace(/\/+$/, "");
    this.siteId = opts.siteId;
    this.secretKey = opts.secretKey;
    this.userAgent = `spectry-node/${opts.version}`;

    const impl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!impl) {
      throw new Error(
        "No fetch implementation available. @spectry/spectry needs Node 18+, " +
          "or pass `fetch` in the client options.",
      );
    }
    this.fetchImpl = impl;
  }

  url(path: string): string {
    return `${this.apiHost}/api/v1/server-sdk/${encodeURIComponent(this.siteId)}${path}`;
  }

  async request<T>(options: RequestOptions): Promise<TransportResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout);

    // Honour a caller-supplied signal (client shutdown) as well as the timeout.
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const response = await this.fetchImpl(this.url(options.path), {
        method: options.method ?? "GET",
        headers: {
          // A secret key (`sk_…`), as a bearer credential. Deliberately not the
          // `x-spectry-key` header the browser SDK uses for the site's public
          // write key: these are two different credentials, and the API rejects
          // each one on the other's routes so a mix-up fails loudly instead of
          // quietly publishing a secret.
          authorization: `Bearer ${this.secretKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": this.userAgent,
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });

      const etag = response.headers.get("etag");

      // Nothing changed since the version we sent — no body to read.
      if (response.status === 304) {
        return { status: 304, data: null, etag };
      }

      if (!response.ok) {
        throw new SpectryHttpError(response.status, await safeText(response));
      }

      const text = await safeText(response);
      const data = text ? (JSON.parse(text) as T) : null;
      return { status: response.status, data, etag };
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Spectry request to ${options.path} timed out after ${options.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: string }).name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}
