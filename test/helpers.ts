import type {
  ExperimentDefinition,
  FetchLike,
  FlagDefinition,
  SpectryConfig,
} from "../src/types.js";

export function flag(overrides: Partial<FlagDefinition> = {}): FlagDefinition {
  return {
    key: "my-flag",
    type: "boolean",
    enabled: true,
    default_value: false,
    variants: [],
    rollout_percentage: 100,
    targeting_rules: {},
    ...overrides,
  };
}

export function experiment(
  overrides: Partial<ExperimentDefinition> = {},
): ExperimentDefinition {
  return {
    id: "exp-a",
    name: "Experiment A",
    test_type: "visual",
    target_url: "https://example.com",
    traffic_split: 100,
    targeting_rules: {},
    variations: [
      { id: "control", name: "Control" },
      { id: "v1", name: "Variation 1" },
    ],
    ...overrides,
  };
}

export function config(overrides: Partial<SpectryConfig> = {}): SpectryConfig {
  return {
    siteId: "site-1",
    version: 'W/"v1"',
    generatedAt: new Date().toISOString(),
    flags: [flag()],
    experiments: [experiment()],
    ...overrides,
  };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeFetch {
  impl: FetchLike;
  requests: RecordedRequest[];
  /** Queue one response for the next call; falls back to `respondWith`. */
  queue(response: FakeResponse): void;
  respondWith(response: FakeResponse | ((req: RecordedRequest) => FakeResponse)): void;
  reset(): void;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  etag?: string;
  /** Reject instead of responding — a network failure. */
  throws?: Error;
  /** Never settle, to exercise the timeout. */
  hang?: boolean;
}

export function fakeFetch(initial?: FakeResponse): FakeFetch {
  const requests: RecordedRequest[] = [];
  const queued: FakeResponse[] = [];
  let fallback: FakeResponse | ((req: RecordedRequest) => FakeResponse) =
    initial ?? { status: 200, body: config() };

  const impl: FetchLike = async (url, init) => {
    const record: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    requests.push(record);

    const response = queued.shift() ?? (typeof fallback === "function" ? fallback(record) : fallback);

    if (response.hang) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }

    if (response.throws) throw response.throws;

    const status = response.status ?? 200;
    const text = response.body === undefined ? "" : JSON.stringify(response.body);
    const etag = response.etag ?? (response.body as { version?: string })?.version ?? null;

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === "etag" ? etag : null) },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  return {
    impl,
    requests,
    queue: (response) => queued.push(response),
    respondWith: (response) => {
      fallback = response;
    },
    reset: () => {
      requests.length = 0;
      queued.length = 0;
    },
  };
}

/** Let queued microtasks and timers settle. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
