import { describe, expect, it } from "@jest/globals";
import {
  BUCKET_COUNT,
  bucketFor,
  consistentHash,
  fnv1a,
  inTrafficAllocation,
  normalizeWeights,
  pickVariation,
} from "../src/hashing.js";

/**
 * Parity tests.
 *
 * The values below are what `spectry-api` computes for the same inputs. If one
 * of them changes, this SDK and the server have stopped agreeing on who is in
 * which bucket — which means the dashboard is reporting one assignment while
 * the customer's code acted on another. Fix the drift; never update the number
 * to make the test pass.
 */
describe("hashing", () => {
  describe("consistentHash (flags, SHA-256)", () => {
    it("matches the server's buckets", () => {
      expect(consistentHash("my-flag", "visitor-1")).toBe(66);
      expect(consistentHash("my-flag", "visitor-2")).toBe(74);
      expect(consistentHash("other-flag", "visitor-1")).toBe(1);
      expect(consistentHash("my-flag:variant", "visitor-1")).toBe(50);
      expect(consistentHash("my-flag", "")).toBe(13);
    });

    it("stays within 0-99", () => {
      for (let i = 0; i < 300; i++) {
        const bucket = consistentHash("flag", `visitor-${i}`);
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(100);
      }
    });

    it("spreads visitors roughly evenly", () => {
      const below = Array.from({ length: 2000 }, (_, i) =>
        consistentHash("flag", `visitor-${i}`),
      ).filter((b) => b < 50).length;
      expect(below).toBeGreaterThan(900);
      expect(below).toBeLessThan(1100);
    });

    it("gives a flag's rollout and variant draws independent buckets", () => {
      // The variant draw is salted with `:variant` precisely so that being in
      // the rollout does not correlate with which variant you land on.
      expect(consistentHash("my-flag", "visitor-1")).not.toBe(
        consistentHash("my-flag:variant", "visitor-1"),
      );
    });
  });

  describe("fnv1a (experiments)", () => {
    it("matches the canonical 32-bit vectors", () => {
      expect(fnv1a("")).toBe(2166136261);
      expect(fnv1a("a")).toBe(3826002220);
      expect(fnv1a("hello")).toBe(1335831723);
    });

    it("matches the browser and the API bucket for bucket", () => {
      expect(bucketFor("visitor-1", "exp-a", "variant")).toBe(8399);
      expect(bucketFor("visitor-1", "exp-a", "traffic")).toBe(7163);
      expect(bucketFor("visitor-2", "exp-a", "variant")).toBe(7782);
      expect(bucketFor("visitor-1", "exp-b", "variant")).toBe(3082);
      expect(bucketFor("", "exp-a", "variant")).toBe(2105);
    });

    it("stays within the bucket space", () => {
      for (let i = 0; i < 200; i++) {
        const bucket = bucketFor(`v-${i}`, "exp", "variant");
        expect(bucket).toBeGreaterThanOrEqual(0);
        expect(bucket).toBeLessThan(BUCKET_COUNT);
      }
    });
  });

  describe("inTrafficAllocation", () => {
    it("admits everyone at 100 and no one at 0", () => {
      expect(inTrafficAllocation("v", "e", 100)).toBe(true);
      expect(inTrafficAllocation("v", "e", 0)).toBe(false);
    });

    it("clamps nonsense percentages", () => {
      expect(inTrafficAllocation("v", "e", 500)).toBe(true);
      expect(inTrafficAllocation("v", "e", -1)).toBe(false);
      expect(inTrafficAllocation("v", "e", undefined as unknown as number)).toBe(true);
    });

    it("admits about the requested share", () => {
      const admitted = Array.from({ length: 2000 }, (_, i) =>
        inTrafficAllocation(`v-${i}`, "exp", 30),
      ).filter(Boolean).length;
      expect(admitted).toBeGreaterThan(520);
      expect(admitted).toBeLessThan(680);
    });

    it("is stable for a given visitor", () => {
      const first = inTrafficAllocation("visitor-7", "exp", 50);
      for (let i = 0; i < 5; i++) {
        expect(inTrafficAllocation("visitor-7", "exp", 50)).toBe(first);
      }
    });
  });

  describe("normalizeWeights", () => {
    it("splits evenly when nothing is weighted", () => {
      expect(normalizeWeights([{}, {}])).toEqual([50, 50]);
      expect(normalizeWeights([{}, {}, {}, {}])).toEqual([25, 25, 25, 25]);
    });

    it("hands the remainder to the unweighted", () => {
      expect(normalizeWeights([{ weight: 70 }, {}])).toEqual([70, 30]);
    });

    it("averages when explicit weights leave no remainder", () => {
      expect(normalizeWeights([{ weight: 100 }, {}])).toEqual([100, 100]);
    });

    it("rejects unusable weights", () => {
      expect(normalizeWeights([{ weight: NaN }, { weight: -1 }])).toEqual([50, 50]);
      expect(normalizeWeights([{ weight: Infinity }, {}])).toEqual([50, 50]);
    });
  });

  describe("pickVariation", () => {
    const variations: Array<{ id: string; weight?: number }> = [{ id: "a" }, { id: "b" }];

    it("returns null with nothing to pick", () => {
      expect(pickVariation("v", "e", [])).toBeNull();
    });

    it("is sticky", () => {
      const first = pickVariation("visitor-1", "exp", variations);
      expect(pickVariation("visitor-1", "exp", variations)).toBe(first);
    });

    it("respects weights", () => {
      const weighted = [
        { id: "a", weight: 80 },
        { id: "b", weight: 20 },
      ];
      const b = Array.from({ length: 1000 }, (_, i) =>
        pickVariation(`v-${i}`, "exp", weighted),
      ).filter((v) => v?.id === "b").length;
      expect(b).toBeGreaterThan(140);
      expect(b).toBeLessThan(270);
    });

    it("still splits when every weight is zero", () => {
      const zeroed = [
        { id: "a", weight: 0 },
        { id: "b", weight: 0 },
      ];
      const ids = new Set(
        Array.from({ length: 40 }, (_, i) => pickVariation(`v-${i}`, "exp", zeroed)?.id),
      );
      expect(ids.size).toBe(2);
    });
  });
});
