/**
 * `@spectry/spectry` — the official Spectry SDK for Node.js.
 *
 * Feature flags, A/B test assignment and server-side event tracking, evaluated
 * locally from a cached config so nothing on your request path waits on us.
 *
 * ```ts
 * import { SpectryClient } from "@spectry/spectry";
 *
 * const client = new SpectryClient({ siteId: "...", secretKey: "..." });
 * await client.init({ timeout: 1000 });
 *
 * const spectry = client.createScopedInstance({ attributes: { id: user.id } });
 * if (spectry.isOn("new-checkout")) { ... }
 * spectry.logEvent("Payment Accepted", { amount: 49 });
 * ```
 */

export { SpectryClient, SDK_VERSION } from "./client.js";
export { ScopedSpectry } from "./scoped.js";
export { SpectryHttpError } from "./transport.js";
export { spectryMiddleware, attributesFromRequest } from "./express.js";
export type { SpectryMiddlewareOptions } from "./express.js";

// Exported so you can unit-test your own flag logic against the real
// evaluator, and so a debug endpoint can explain an assignment.
export {
  evaluateFlag,
  evaluateAllFlags,
  assignExperiment,
} from "./evaluate.js";
export { matchesTargeting } from "./targeting.js";
export {
  consistentHash,
  fnv1a,
  bucketFor,
  inTrafficAllocation,
  pickVariation,
  normalizeWeights,
  BUCKET_COUNT,
} from "./hashing.js";
export { defaultLogger, silentLogger } from "./logger.js";

export type {
  Assignment,
  Attributes,
  ExperimentDefinition,
  ExperimentVariation,
  FeatureResult,
  FeatureSource,
  FetchLike,
  FlagDefinition,
  FlagTargetingRules,
  FlagValue,
  FlagVariant,
  InitOptions,
  Logger,
  SpectryClientOptions,
  SpectryConfig,
  SpectryEvent,
  UserContext,
} from "./types.js";
