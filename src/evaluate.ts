import { consistentHash, inTrafficAllocation, pickVariation } from "./hashing.js";
import { matchesTargeting } from "./targeting.js";
import type {
  Assignment,
  Attributes,
  ExperimentDefinition,
  FeatureResult,
  FlagDefinition,
} from "./types.js";

/**
 * Local evaluation — the reason this SDK exists.
 *
 * Every function here is a port of the server's own evaluator
 * (`spectry-api/app/services/feature-flag.service.ts` and
 * `app/api/v1/server-sdk.controller.ts`). Given the same definitions and the
 * same user, they must return the same answer, because the dashboard's results
 * are computed from what the server thinks happened.
 */

const NOT_READY: FeatureResult = Object.freeze({
  value: null,
  on: false,
  off: true,
  source: "notReady",
});

function result(
  value: FlagDefinition["default_value"],
  source: FeatureResult["source"],
  variantKey?: string,
): FeatureResult {
  return {
    value,
    on: !!value,
    off: !value,
    source,
    ...(variantKey === undefined ? {} : { variantKey }),
  };
}

/**
 * Pick a multivariate flag's variant.
 *
 * Mirrors `selectVariant` on the server, including its quirks: the seed is
 * `"<flagKey>:variant"` (so a flag's rollout draw and its variant draw are
 * independent), a missing or zero weight counts as 1, and the walk compares
 * against `(hash / 100) * totalWeight`.
 */
function selectVariant(flag: FlagDefinition, visitorId: string): FeatureResult {
  const variants = flag.variants;
  const hash = consistentHash(`${flag.key}:variant`, visitorId);
  const totalWeight = variants.reduce((sum, v) => sum + (v.weight || 1), 0);
  const normalized = (hash / 100) * totalWeight;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight || 1;
    if (normalized < cumulative) return result(variant.value, "variant", variant.key);
  }

  const last = variants[variants.length - 1];
  return last ? result(last.value, "variant", last.key) : result(null, "variant");
}

/** Resolve one flag for one user. */
export function evaluateFlag(
  flag: FlagDefinition | undefined,
  attributes: Attributes,
  visitorId: string,
): FeatureResult {
  if (!flag) return { ...NOT_READY, source: "unknownFlag" };

  if (!flag.enabled) return result(flag.default_value, "disabled");

  // Targeting decides who is eligible; rollout decides how many of the eligible
  // get it. A 10% rollout of a Germany-targeted flag is 10% of Germany.
  if (!matchesTargeting(flag.targeting_rules, attributes)) {
    return result(flag.default_value, "targeting");
  }

  const rollout =
    typeof flag.rollout_percentage === "number" ? flag.rollout_percentage : 100;
  if (rollout < 100) {
    // Without an id there is no stable bucket, so a rollout below 100% cannot
    // be honoured. Excluding is the safe answer: a partial rollout must never
    // become a full one because the caller forgot an attribute.
    if (!visitorId) return result(flag.default_value, "rollout");
    // `>=` matches the server. With `>`, a 50% rollout reached 51% of users
    // and a 0% rollout still reached the ~1% who hashed to bucket 0.
    if (consistentHash(flag.key, visitorId) >= rollout) {
      return result(flag.default_value, "rollout");
    }
  }

  if (flag.type === "multivariate" && flag.variants?.length > 0) {
    if (!visitorId) return result(flag.default_value, "rollout");
    return selectVariant(flag, visitorId);
  }

  return result(true, "enabled");
}

/** Resolve every flag in the config for one user. */
export function evaluateAllFlags(
  flags: FlagDefinition[],
  attributes: Attributes,
  visitorId: string,
): Record<string, FeatureResult> {
  const out: Record<string, FeatureResult> = {};
  for (const flag of flags) {
    out[flag.key] = evaluateFlag(flag, attributes, visitorId);
  }
  return out;
}

/**
 * Assign a user to a variation, or `null` when they are not in the experiment.
 *
 * `null` is not the control group. A user outside the traffic allocation was
 * never exposed to the test at all, and counting them as a control would bias
 * every result the dashboard reports.
 */
export function assignExperiment(
  experiment: ExperimentDefinition,
  attributes: Attributes,
  visitorId: string,
): Assignment | null {
  if (!visitorId) return null;
  if (!experiment.variations || experiment.variations.length === 0) return null;
  if (!matchesTargeting(experiment.targeting_rules, attributes)) return null;

  const traffic =
    typeof experiment.traffic_split === "number" ? experiment.traffic_split : 100;
  if (!inTrafficAllocation(visitorId, experiment.id, traffic)) return null;

  const variation = pickVariation(visitorId, experiment.id, experiment.variations);
  if (!variation) return null;

  return {
    experimentId: experiment.id,
    experimentName: experiment.name,
    variationId: variation.id,
    variationName: variation.name,
  };
}

export { NOT_READY };
