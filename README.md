# @spectry/spectry

Official [Spectry](https://spectry.io) SDK for Node.js — feature flags, A/B test assignment and server-side event tracking.

Flag definitions are fetched once, cached in memory and refreshed in the background, so `isOn()` is a synchronous in-process lookup. Nothing on your request path waits on Spectry.

- **Zero runtime dependencies**
- **ESM and CommonJS**, with TypeScript types
- **Fails open** — if Spectry is unreachable, your fallbacks are used and the last good config keeps serving

## Install

```bash
npm install @spectry/spectry
# or
pnpm add @spectry/spectry
# or
yarn add @spectry/spectry
```

Requires Node 18 or newer (for global `fetch`).

## Setup

Create **one client per process**, at boot.

```js
const { SpectryClient } = require("@spectry/spectry");

const client = new SpectryClient({
  siteId: process.env.SPECTRY_SITE_ID,
  secretKey: process.env.SPECTRY_SECRET_KEY,
});

await client.init({ timeout: 1000 });
```

```ts
import { SpectryClient } from "@spectry/spectry";
```

> **The secret key is a server-side secret.** It reads every flag definition for your site and accepts writes. Keep it in an environment variable and never ship it to a browser. The browser SDK uses a different, origin-gated endpoint.
>
> Create one under **Site settings → API keys** in the dashboard. The value is shown once, at creation, and cannot be retrieved afterwards — if you lose it, revoke it and make another.
>
> **It is not the write key.** The write key (`wk_…`) is the one in your `<script>` snippet as `data-write-key`; it is public by design, since anyone can read it out of your page source. Sending it here is rejected, and sending a secret key from a browser is rejected too, so mixing them up fails loudly instead of quietly publishing this one.

### Rotating a key

Keys are independent, so rotation needs no downtime window:

1. Create a second key and deploy it.
2. Watch **Last used** on the old key in the dashboard until it stops advancing.
3. Revoke the old key. Revocation takes effect within a minute.

Then create a per-request instance scoped to the current user and store it on the request.

```js
app.use((req, res, next) => {
  req.spectry = client.createScopedInstance({
    attributes: {
      id: req.user.id,
    },
  });
  next();
});
```

`createScopedInstance()` makes no network call and copies no definitions, so per request is exactly right. Creating a *client* per request would refetch the config every time and defeat the caching entirely.

If you use Express, the bundled middleware does the same thing:

```js
const { spectryMiddleware } = require("@spectry/spectry");

app.use(spectryMiddleware(client, {
  context: (req) => ({ attributes: { id: req.user.id } }),
}));
```

## Targeting attributes

Replace the placeholders with your real values. These are what targeting rules match on.

```js
app.use((req, res, next) => {
  req.spectry = client.createScopedInstance({
    attributes: {
      id: req.user.id,
      url: req.originalUrl,
      path: req.path,
      host: req.hostname,
      country: "DE",
      browser: "chrome",
      deviceType: "desktop",
      plan: "scale",
      utmSource: "foo",
      utmMedium: "foo",
      utmCampaign: "foo",
    },
  });
  next();
});
```

`id` is the bucketing seed: the same `id` always lands on the same side of a percentage rollout and in the same variant. Without it, rollouts below 100% and all experiments fall back to defaults — there is no stable bucket to compute.

`attributesFromRequest(req)` fills in `url`, `path`, `host`, the UTM parameters and a coarse `deviceType` / `browser` from the User-Agent:

```js
const { attributesFromRequest } = require("@spectry/spectry");

client.createScopedInstance({
  attributes: { ...attributesFromRequest(req), id: req.user.id },
});
```

Targeting rules are ANDed, and a rule that needs an attribute you did not supply **fails closed** — a flag targeted at `country: ["DE"]` is off for a user with no `country`, rather than on for everyone.

## Usage

### On/off feature

```js
app.get("/", (req, res) => {
  if (req.spectry.isOn("my-feature")) {
    res.send("Feature is enabled!");
  } else {
    res.send("Feature is disabled");
  }
});
```

### String feature

```js
app.get("/", (req, res) => {
  const value = req.spectry.getFeatureValue("my-feature", "fallback");
  res.send("The feature value is: " + value);
});
```

The fallback is returned when the flag does not exist, has no value for this user, or the config has not loaded yet. Make it the behaviour you would ship if Spectry were unreachable.

### Why a flag resolved the way it did

```js
req.spectry.getFeature("my-feature");
// { value: false, on: false, off: true, source: "rollout" }
```

`source` is one of `unknownFlag`, `notReady`, `disabled`, `targeting`, `rollout`, `variant` or `enabled` — useful in a debug endpoint when someone asks why they are not seeing a feature.

### A/B test assignment

```js
const assignment = req.spectry.getVariation("<experiment-id>");
// { experimentId, experimentName, variationId, variationName } | null

req.spectry.getExperiments(); // every experiment this user is in
```

Assignment matches the browser SDK exactly, so a user bucketed server-side sees the same variant client-side.

`null` means the user is **not in the experiment** — they fell outside the traffic allocation or missed its targeting. That is not the same as being in the control group; do not count it as one.

## Event tracking

Log the events you care about so they can be used as experiment metrics.

```js
// Simple (no properties)
req.spectry.logEvent("Payment Accepted");

// With custom properties
req.spectry.logEvent("Request Completed", {
  latency: 250,
});
```

`logEvent()` is synchronous, queues in memory and never throws — it is called from request handlers, where neither added latency nor an exception is acceptable. Events are batched and sent in the background.

Because the queue lives in memory, **flush before the process exits**:

```js
process.on("SIGTERM", async () => {
  await client.close(); // stops refreshing and flushes queued events
  server.close();
});
```

On serverless, where the process can be frozen the moment a response is sent, flush per request instead:

```js
app.use(spectryMiddleware(client, {
  context: (req) => ({ attributes: { id: req.user.id } }),
  flushOnResponse: true,
}));
```

## Caching and refresh

| | |
|---|---|
| On `init()` | Fetches `GET /api/v1/server-sdk/:siteId/config` and caches flag + experiment definitions |
| Every `refreshInterval` (default 60s) | Re-fetches with `If-None-Match`; an unchanged config costs a `304` and no body |
| On a failed refresh | **Keeps serving the last good config** and retries on the next tick |
| On a `401`/`403` | Stops polling and logs once — a bad key will not fix itself |
| On `close()` | Stops the timer and flushes queued events |

The refresh timer is `unref()`'d, so a short-lived script still exits.

`init()` resolves `false` rather than throwing when the first fetch fails, and polling continues — a client that starts degraded recovers on its own without a restart. Pass `{ throwOnFailure: true }` to fail fast instead.

```js
client.getStatus();
// { ready, version, flagCount, experimentCount, lastUpdatedAt,
//   lastAttemptAt, consecutiveFailures, queuedEvents, sdkVersion }
```

`version` is the config version — it tells you whether a flag change has landed. Useful in a health check.

## Options

```js
new SpectryClient({
  siteId: "...",              // required
  secretKey: "sk_live_...",   // required — server-side secret, never in a browser
  apiHost: "https://api.spectry.io",
  refreshInterval: 60000,     // ms; 0 disables polling
  timeout: 3000,              // ms, per network call
  eventFlushInterval: 5000,   // ms a queued event may wait
  eventBatchSize: 25,         // events per request (API max 100)
  maxQueuedEvents: 1000,      // ceiling; oldest are dropped past it
  logger: console,            // or `false` to silence the SDK
  fetch: customFetch,         // for a proxy or an HTTP agent
  onError: (err, { operation }) => reportToSentry(err),
});
```

The event queue is bounded on purpose: an unbounded one turns an API outage into the host process running out of memory.

## API

### `SpectryClient`

| Member | Description |
|---|---|
| `init(options?)` | Loads the config and starts refreshing. Resolves `true`/`false`. |
| `createScopedInstance(context?)` | A `ScopedSpectry` for one user. Cheap and synchronous. |
| `refresh()` | Refreshes now, out of band. Resolves `true`/`false`. |
| `flush()` | Sends queued events now. |
| `close()` | Stops polling and flushes. Safe to call twice. |
| `ready` | Whether a config has loaded. |
| `getConfig()` | The cached config, or `null`. Read-only. |
| `getStatus()` | Cache and queue state. |

### `ScopedSpectry`

| Member | Description |
|---|---|
| `isOn(key)` / `isOff(key)` | Boolean check. Unknown flags are off. |
| `getFeatureValue(key, fallback)` | Value, or the fallback. |
| `getFeature(key)` | `{ value, on, off, source, variantKey? }`. |
| `getAllFeatures()` | Every flag resolved for this user. |
| `getVariation(id)` | Assignment, or `null` if not in the experiment. |
| `getExperiments()` | Every experiment this user is in. |
| `logEvent(name, properties?)` | Queue an event. Never throws. |
| `flush()` | Send queued events now. |
| `ready` | Whether the config has loaded. |

### Evaluation internals

`evaluateFlag`, `evaluateAllFlags`, `assignExperiment`, `matchesTargeting`, `consistentHash`, `fnv1a`, `bucketFor`, `inTrafficAllocation`, `pickVariation` and `normalizeWeights` are exported so you can unit-test your own flag logic against the real evaluator, or explain an assignment in a debug endpoint.

## Testing your own code

Pass a fake `fetch` and skip the network entirely:

```js
const client = new SpectryClient({
  siteId: "test", secretKey: "sk_test_x",
  refreshInterval: 0, logger: false,
  fetch: async () => ({
    ok: true, status: 200,
    headers: { get: () => 'W/"1"' },
    text: async () => JSON.stringify({
      siteId: "test", version: 'W/"1"', generatedAt: "", experiments: [],
      flags: [{
        key: "my-feature", type: "boolean", enabled: true,
        default_value: false, variants: [], rollout_percentage: 100,
        targeting_rules: {},
      }],
    }),
  }),
});

await client.init();
client.createScopedInstance({ attributes: { id: "u1" } }).isOn("my-feature"); // true
```

## License

MIT
