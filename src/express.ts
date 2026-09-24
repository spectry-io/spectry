import type { SpectryClient } from "./client.js";
import type { ScopedSpectry } from "./scoped.js";
import type { Attributes, UserContext } from "./types.js";

/**
 * Optional Express glue. Import it or don't — the SDK has no opinion, and no
 * dependency on Express either. These types are structural, so nothing here
 * requires `@types/express` to be installed.
 */

interface MinimalRequest {
  originalUrl?: string;
  url?: string;
  path?: string;
  hostname?: string;
  query?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

interface MinimalResponse {
  on(event: string, listener: () => void): unknown;
}

export interface SpectryMiddlewareOptions {
  /**
   * Build the user context for a request. Return at least `attributes.id` —
   * without a stable id, percentage rollouts and experiments cannot bucket
   * anyone and every flag falls back to its default.
   */
  context: (req: MinimalRequest) => UserContext;
  /** Property to hang the instance off. Default `"spectry"`. */
  property?: string;
  /**
   * Flush queued events when the response finishes. Off by default — batching
   * across requests is cheaper. Turn it on for serverless, where the process
   * can be frozen the moment a response is sent.
   */
  flushOnResponse?: boolean;
}

/**
 * Attach a per-request `ScopedSpectry` to every request.
 *
 * ```ts
 * app.use(spectryMiddleware(client, {
 *   context: (req) => ({ attributes: { id: req.user.id } }),
 * }));
 *
 * app.get("/", (req, res) => {
 *   res.send(req.spectry.isOn("new-homepage") ? "new" : "old");
 * });
 * ```
 */
export function spectryMiddleware(
  client: SpectryClient,
  options: SpectryMiddlewareOptions,
) {
  const property = options.property ?? "spectry";

  return function spectryRequestMiddleware(
    req: MinimalRequest,
    res: MinimalResponse,
    next: (error?: unknown) => void,
  ): void {
    try {
      const scoped = client.createScopedInstance(options.context(req));
      (req as Record<string, unknown>)[property] = scoped;

      if (options.flushOnResponse) {
        res.on("finish", () => {
          void scoped.flush().catch(() => {});
        });
      }
    } catch {
      // Analytics must never be the reason a request 500s. Without the
      // instance the route's own `req.spectry?` guards take over.
    }
    next();
  };
}

/**
 * Targeting attributes pulled from a request: url, path, host, the UTM
 * parameters and a coarse device/browser guess from the User-Agent.
 *
 * A convenience, not a requirement — merge it with your own `id` and whatever
 * else your rules target on.
 */
export function attributesFromRequest(req: MinimalRequest): Attributes {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const userAgent = headerValue(req, "user-agent");

  const attributes: Attributes = {
    url: req.originalUrl ?? req.url ?? "",
    path: req.path ?? "",
    host: req.hostname ?? headerValue(req, "host") ?? "",
    deviceType: deviceTypeFrom(userAgent),
    browser: browserFrom(userAgent),
  };

  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const value = query[key];
    if (typeof value === "string" && value) {
      attributes[camelCase(key)] = value;
    }
  }

  return attributes;
}

function headerValue(req: MinimalRequest, name: string): string {
  const raw = req.headers?.[name];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

function camelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Coarse on purpose. It must agree with how the browser SDK labels the same
 * visitor, since a `device` rule is evaluated against whichever one reported —
 * so the vocabulary is exactly `mobile` / `tablet` / `desktop`.
 */
function deviceTypeFrom(userAgent: string): string {
  if (!userAgent) return "";
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk|android(?!.*mobile)/.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|blackberry|windows phone/.test(ua)) return "mobile";
  return "desktop";
}

function browserFrom(userAgent: string): string {
  if (!userAgent) return "";
  const ua = userAgent.toLowerCase();
  // Order matters: Edge and Opera both claim to be Chrome, and Chrome claims
  // to be Safari.
  if (ua.includes("edg/") || ua.includes("edge/")) return "edge";
  if (ua.includes("opr/") || ua.includes("opera")) return "opera";
  if (ua.includes("firefox/")) return "firefox";
  if (ua.includes("chrome/") || ua.includes("crios/")) return "chrome";
  if (ua.includes("safari/")) return "safari";
  return "";
}

export type { ScopedSpectry };
