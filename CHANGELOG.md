# Changelog

## Unreleased

- **`clientKey` is now `secretKey`, and takes a secret key (`sk_…`) rather than
  the site's write key.** The write key ships to browsers in the tracking
  snippet, so it never authenticated anything here — it was readable from any
  customer's page source. Create a secret key under Site settings → API keys.
- Credentials are now sent as `Authorization: Bearer`, not `x-spectry-key`. The
  API rejects a write key on these routes and a secret key on the browser
  routes, so the two cannot be swapped silently.
- Keys carry scopes (`config:read`, `events:write`); a key without the scope for
  a route gets a 403.

## 0.1.0

Initial release.

- `SpectryClient` with cached flag and experiment definitions, background
  refresh with `If-None-Match`, and stale-on-failure behaviour.
- `createScopedInstance()` for synchronous per-request evaluation:
  `isOn`, `isOff`, `getFeatureValue`, `getFeature`, `getAllFeatures`.
- A/B assignment via `getVariation` / `getExperiments`, bucket-for-bucket
  identical to the browser SDK.
- Server-side custom events through `logEvent()`, batched and bounded.
- Optional Express middleware and `attributesFromRequest()`.
- ESM + CommonJS builds, TypeScript types, no runtime dependencies.
