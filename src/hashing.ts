import { createHash } from "node:crypto";

/**
 * The two hashes Spectry buckets with. Both are ports, and the only thing that
 * makes them worth having locally is that they agree with the server exactly —
 * that is what lets this SDK answer `isOn()` from memory instead of asking the
 * API once per request.
 *
 * | what                  | hash     | mirrors                                             |
 * |-----------------------|----------|-----------------------------------------------------|
 * | flag rollout + variant| SHA-256  | `spectry-api/app/services/feature-flag.service.ts`   |
 * | experiment assignment | FNV-1a   | `spectry-api/app/helpers/bucketing.ts`, which is     |
 * |                       |          | itself a port of `spectry-js` `experiments/assignment.ts` |
 *
 * They are genuinely different functions over different bucket counts, not an
 * inconsistency to tidy up: flags were built against SHA-256 and experiments
 * against FNV-1a, and changing either would silently reshuffle every live
 * assignment. `test/hashing.test.ts` pins the vectors all three codebases have
 * to agree on.
 */

// ---------------------------------------------------------------------------
// Feature flags — SHA-256, 100 buckets
// ---------------------------------------------------------------------------

/**
 * Bucket a visitor into 0–99 for `key`.
 *
 * Takes the first four bytes of `sha256("<key>:<visitorId>")` as a big-endian
 * uint32 and mods by 100 — the same four bytes, the same order, the same
 * modulus as the API.
 */
export function consistentHash(key: string, visitorId: string): number {
  const digest = createHash("sha256").update(`${key}:${visitorId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

// ---------------------------------------------------------------------------
// Experiments — FNV-1a, 10000 buckets
// ---------------------------------------------------------------------------

export const BUCKET_COUNT = 10000;

/**
 * FNV-1a 32-bit.
 *
 * `Math.imul` is load-bearing: a plain `hash * 0x01000193` loses precision past
 * 2^53 and diverges from the browser's answer, which is the one thing this
 * function exists to match.
 */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Bucket in [0, BUCKET_COUNT) for an experiment draw. */
export function bucketFor(seed: string, experimentId: string, salt = ""): number {
  return fnv1a(`${seed}:${experimentId}${salt ? ":" + salt : ""}`) % BUCKET_COUNT;
}

/** Is this visitor inside the experiment's traffic allocation (0–100)? */
export function inTrafficAllocation(
  seed: string,
  experimentId: string,
  trafficPercent: number,
): boolean {
  const pct = Math.max(0, Math.min(100, Number(trafficPercent ?? 100)));
  if (pct >= 100) return true;
  if (pct <= 0) return false;
  return bucketFor(seed, experimentId, "traffic") < pct * (BUCKET_COUNT / 100);
}

/**
 * Relative weights, with unweighted variations sharing the remainder up to 100.
 * When the explicit weights already reach 100 there is no remainder to share,
 * so unweighted variations take the average explicit weight rather than zero —
 * zero would make them unreachable.
 */
export function normalizeWeights(variations: Array<{ weight?: number }>): number[] {
  const explicit = variations.map((v) =>
    typeof v.weight === "number" && isFinite(v.weight) && v.weight >= 0 ? v.weight : null,
  );
  const explicitSum = explicit.reduce<number>((a, b) => a + (b ?? 0), 0);
  const unweighted = explicit.filter((w) => w === null).length;
  if (unweighted === 0) return explicit.map((w) => w ?? 0);
  const remainder = Math.max(0, 100 - explicitSum);
  const fill =
    remainder > 0
      ? remainder / unweighted
      : explicitSum / Math.max(1, variations.length - unweighted);
  return explicit.map((w) => (w === null ? fill : w));
}

/** Deterministic weighted pick. Weights are relative and need not sum to 100. */
export function pickVariation<T extends { weight?: number }>(
  seed: string,
  experimentId: string,
  variations: T[],
): T | null {
  if (variations.length === 0) return null;
  const weights = normalizeWeights(variations);
  const total = weights.reduce((a, b) => a + b, 0);
  const bucket = bucketFor(seed, experimentId, "variant");
  if (total <= 0) return variations[bucket % variations.length] ?? null;

  const point = (bucket / BUCKET_COUNT) * total;
  let acc = 0;
  for (let i = 0; i < variations.length; i++) {
    acc += weights[i] ?? 0;
    if (point < acc) return variations[i] ?? null;
  }
  return variations[variations.length - 1] ?? null;
}
