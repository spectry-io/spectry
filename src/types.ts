/**
 * The wire and public types for `@spectry/spectry`.
 *
 * The `*Definition` shapes use snake_case because that is exactly what
 * `GET /api/v1/server-sdk/:siteId/config` returns; they are kept verbatim so a
 * cached config can be inspected, logged or persisted without a translation
 * layer that could drift from the server. Everything the caller touches
 * directly is camelCase.
 */

/** Any value a flag can carry. Boolean flags resolve to `true`/`false`. */
export type FlagValue =
  | boolean
  | string
  | number
  | null
  | { [key: string]: unknown }
  | unknown[];

export interface FlagVariant {
  key: string;
  value: FlagValue;
  /** Relative weight against the other variants. Missing is treated as 1. */
  weight: number;
}

/**
 * Rules are ANDed. An absent or empty rule constrains nothing; a rule that
 * needs an attribute the caller did not supply fails closed.
 */
export interface FlagTargetingRules {
  /** Two-letter country codes, matched case-insensitively. */
  geo?: string[];
  browser?: string[];
  device?: string[];
  /** Accepted as an alias of `device`, which the dashboard also writes. */
  devices?: string[];
  userProperty?: { key: string; value: unknown };
}

export interface FlagDefinition {
  key: string;
  type: "boolean" | "multivariate";
  enabled: boolean;
  default_value: FlagValue;
  variants: FlagVariant[];
  /** 0–100. Applied after targeting, so it is a share of the targeted audience. */
  rollout_percentage: number;
  targeting_rules: FlagTargetingRules;
}

export interface ExperimentVariation {
  id: string;
  name: string;
  /** Relative weight. Unweighted variations share the remainder up to 100. */
  weight?: number;
  isControl?: boolean;
}

export interface ExperimentDefinition {
  id: string;
  name: string;
  test_type: string;
  target_url: string;
  /** 0–100 of visitors admitted to the experiment at all. */
  traffic_split: number;
  targeting_rules: FlagTargetingRules;
  variations: ExperimentVariation[];
}

/** The payload cached by the client and refreshed on a timer. */
export interface SpectryConfig {
  siteId: string;
  /** Opaque version, sent back as `If-None-Match` so an unchanged poll is a 304. */
  version: string;
  generatedAt: string;
  flags: FlagDefinition[];
  experiments: ExperimentDefinition[];
}

/**
 * Targeting attributes for one user.
 *
 * `id` is the bucketing seed: the same `id` always lands in the same variant
 * and on the same side of a rollout. `country`, `browser` and `deviceType` are
 * the attributes targeting rules can match; anything else you add is available
 * to a `userProperty` rule.
 */
export interface Attributes {
  /** Stable per-user identifier. Without it, flags fall back to their defaults. */
  id?: string;
  country?: string;
  browser?: string;
  deviceType?: string;
  url?: string;
  path?: string;
  host?: string;
  [key: string]: unknown;
}

export interface UserContext {
  attributes?: Attributes;
  /** Overrides `attributes.id` as the bucketing seed when you keep them apart. */
  visitorId?: string;
  /** Ties server events to a browser session recorded by the JS SDK. */
  sessionId?: string;
}

/** Why a feature resolved to the value it did. Useful in logs and tests. */
export type FeatureSource =
  /** No flag with this key is in the cached config. */
  | "unknownFlag"
  /** The config has not loaded yet, so nothing could be evaluated. */
  | "notReady"
  /** The flag is switched off; its default was returned. */
  | "disabled"
  /** The user did not match the flag's targeting rules. */
  | "targeting"
  /** The user fell outside the rollout percentage. */
  | "rollout"
  /** A multivariate flag picked a variant. */
  | "variant"
  /** A boolean flag is on for this user. */
  | "enabled";

export interface FeatureResult {
  value: FlagValue;
  /** Truthiness of `value`, matching `isOn()`. */
  on: boolean;
  off: boolean;
  source: FeatureSource;
  /** The chosen variant's key, for multivariate flags. */
  variantKey?: string;
}

export interface Assignment {
  experimentId: string;
  experimentName: string;
  variationId: string;
  variationName: string;
}

export interface SpectryEvent {
  name: string;
  properties?: Record<string, unknown>;
  visitorId?: string;
  sessionId?: string;
  url?: string;
  /** Persistent visitor context, stored alongside the event. */
  context?: Record<string, unknown>;
  attributes?: {
    country?: string;
    region?: string;
    city?: string;
    browser?: string;
    deviceType?: string;
  };
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface SpectryClientOptions {
  /** Your site's UUID, from the dashboard. Same id the browser snippet uses. */
  siteId: string;
  /**
   * A **secret key** (`sk_live_…` / `sk_test_…`), created per site under
   * Site settings → API keys. It reads every flag definition and accepts
   * writes, so it must never reach a browser bundle — keep it in an
   * environment variable, not in source.
   *
   * This is **not** the site's write key. The write key (`wk_…`) is published
   * in the browser snippet as `data-write-key` and is public by construction;
   * the API rejects it here, and rejects a secret key on the browser routes, so
   * swapping the two fails loudly rather than silently exposing this one.
   */
  secretKey: string;
  /** Defaults to `https://api.spectry.io`. */
  apiHost?: string;
  /** Config poll interval in ms. Default 60000. Set `0` to disable polling. */
  refreshInterval?: number;
  /** Network timeout in ms for config fetches. Default 3000. */
  timeout?: number;
  /** How long queued events may wait before being sent, in ms. Default 5000. */
  eventFlushInterval?: number;
  /** Events per request. Default 25; the API accepts at most 100. */
  eventBatchSize?: number;
  /** Queue ceiling; the oldest events are dropped past it. Default 1000. */
  maxQueuedEvents?: number;
  /** Pass `false` to silence the SDK entirely. */
  logger?: Logger | false;
  /** Injected for tests, or to route through a proxy/agent. */
  fetch?: FetchLike;
  /** Called for every swallowed error, so you can report it your own way. */
  onError?: (error: Error, context: { operation: string }) => void;
}

export interface InitOptions {
  /** Overrides the client's `timeout` for this first fetch only. */
  timeout?: number;
  /**
   * Throw if the first config fetch fails. Off by default: an SDK that takes
   * down your server because our API blinked is worse than one that serves
   * fallbacks for a minute.
   */
  throwOnFailure?: boolean;
}
