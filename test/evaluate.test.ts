import { describe, expect, it } from "@jest/globals";
import { assignExperiment, evaluateAllFlags, evaluateFlag } from "../src/evaluate.js";
import { consistentHash } from "../src/hashing.js";
import { experiment, flag } from "./helpers.js";

describe("evaluateFlag", () => {
  it("reports an unknown flag rather than guessing", () => {
    const result = evaluateFlag(undefined, {}, "visitor-1");
    expect(result.source).toBe("unknownFlag");
    expect(result.on).toBe(false);
    expect(result.value).toBeNull();
  });

  it("turns an enabled boolean flag on", () => {
    const result = evaluateFlag(flag(), {}, "visitor-1");
    expect(result).toMatchObject({ value: true, on: true, off: false, source: "enabled" });
  });

  it("returns a disabled flag's default instead of hiding it", () => {
    // The server used to omit disabled flags entirely, so callers could not
    // tell "off" from "does not exist" and never saw this value.
    const result = evaluateFlag(
      flag({ enabled: false, default_value: "control-copy" }),
      {},
      "visitor-1",
    );
    expect(result).toMatchObject({ value: "control-copy", source: "disabled" });
  });

  describe("rollout", () => {
    // consistentHash("my-flag", "visitor-1") === 66
    it("includes a visitor below the threshold", () => {
      expect(consistentHash("my-flag", "visitor-1")).toBe(66);
      const result = evaluateFlag(flag({ rollout_percentage: 67 }), {}, "visitor-1");
      expect(result.source).toBe("enabled");
    });

    it("excludes a visitor sitting exactly on the threshold", () => {
      // `>=`, matching the server. With `>` a 66% rollout reached 67%.
      const result = evaluateFlag(flag({ rollout_percentage: 66 }), {}, "visitor-1");
      expect(result.source).toBe("rollout");
      expect(result.value).toBe(false);
    });

    it("serves nobody at zero", () => {
      for (const visitor of ["a", "b", "c", "visitor-1", "visitor-2"]) {
        expect(evaluateFlag(flag({ rollout_percentage: 0 }), {}, visitor).source).toBe(
          "rollout",
        );
      }
    });

    it("skips the hash entirely at 100", () => {
      expect(evaluateFlag(flag({ rollout_percentage: 100 }), {}, "").source).toBe("enabled");
    });

    it("excludes rather than including when there is no visitor id", () => {
      // No id means no stable bucket. Including would silently turn a 10%
      // rollout into a 100% one for every caller that forgot an id.
      const result = evaluateFlag(flag({ rollout_percentage: 50 }), {}, "");
      expect(result.source).toBe("rollout");
    });

    it("is stable across repeated evaluations", () => {
      const f = flag({ rollout_percentage: 50 });
      const first = evaluateFlag(f, {}, "visitor-9").source;
      for (let i = 0; i < 5; i++) {
        expect(evaluateFlag(f, {}, "visitor-9").source).toBe(first);
      }
    });
  });

  describe("multivariate", () => {
    const multivariate = flag({
      type: "multivariate",
      default_value: null,
      variants: [
        { key: "a", value: "copy-a", weight: 50 },
        { key: "b", value: "copy-b", weight: 50 },
      ],
    });

    it("picks a variant and names it", () => {
      const result = evaluateFlag(multivariate, {}, "visitor-1");
      expect(result.source).toBe("variant");
      expect(["copy-a", "copy-b"]).toContain(result.value);
      expect(["a", "b"]).toContain(result.variantKey);
    });

    it("is sticky per visitor", () => {
      const first = evaluateFlag(multivariate, {}, "visitor-1").variantKey;
      for (let i = 0; i < 5; i++) {
        expect(evaluateFlag(multivariate, {}, "visitor-1").variantKey).toBe(first);
      }
    });

    it("honours weights", () => {
      const skewed = flag({
        type: "multivariate",
        variants: [
          { key: "common", value: 1, weight: 90 },
          { key: "rare", value: 2, weight: 10 },
        ],
      });
      const rare = Array.from({ length: 500 }, (_, i) =>
        evaluateFlag(skewed, {}, `visitor-${i}`),
      ).filter((r) => r.variantKey === "rare").length;
      expect(rare).toBeGreaterThan(20);
      expect(rare).toBeLessThan(105);
    });

    it("treats a missing weight as 1, like the server", () => {
      const unweighted = flag({
        type: "multivariate",
        variants: [
          { key: "a", value: "a" } as never,
          { key: "b", value: "b" } as never,
        ],
      });
      const keys = new Set(
        Array.from({ length: 60 }, (_, i) => evaluateFlag(unweighted, {}, `v-${i}`).variantKey),
      );
      expect(keys).toEqual(new Set(["a", "b"]));
    });

    it("falls back to the default when there is no visitor id", () => {
      const result = evaluateFlag(multivariate, {}, "");
      expect(result.value).toBeNull();
      expect(result.source).toBe("rollout");
    });

    it("treats a multivariate flag with no variants as a boolean", () => {
      const empty = flag({ type: "multivariate", variants: [] });
      expect(evaluateFlag(empty, {}, "visitor-1").source).toBe("enabled");
    });
  });

  describe("targeting", () => {
    it("applies rules before the rollout", () => {
      // A 100% rollout of a Germany-only flag is 100% *of Germany*.
      const targeted = flag({ targeting_rules: { geo: ["DE"] }, rollout_percentage: 100 });
      expect(evaluateFlag(targeted, { country: "DE" }, "v1").source).toBe("enabled");
      expect(evaluateFlag(targeted, { country: "FR" }, "v1").source).toBe("targeting");
    });

    it("returns the flag's default when targeting misses", () => {
      const targeted = flag({
        targeting_rules: { geo: ["DE"] },
        default_value: "fallback-copy",
      });
      expect(evaluateFlag(targeted, { country: "FR" }, "v1").value).toBe("fallback-copy");
    });
  });
});

describe("evaluateAllFlags", () => {
  it("resolves every flag by key", () => {
    const results = evaluateAllFlags(
      [flag({ key: "a" }), flag({ key: "b", enabled: false, default_value: "off" })],
      {},
      "visitor-1",
    );
    expect(Object.keys(results)).toEqual(["a", "b"]);
    expect(results["a"]?.value).toBe(true);
    expect(results["b"]?.value).toBe("off");
  });

  it("returns an empty map for an empty config", () => {
    expect(evaluateAllFlags([], {}, "visitor-1")).toEqual({});
  });
});

describe("assignExperiment", () => {
  it("assigns a variation deterministically", () => {
    const first = assignExperiment(experiment(), {}, "visitor-1");
    expect(first).not.toBeNull();
    expect(first!.experimentId).toBe("exp-a");
    expect(["control", "v1"]).toContain(first!.variationId);
    expect(assignExperiment(experiment(), {}, "visitor-1")!.variationId).toBe(
      first!.variationId,
    );
  });

  it("returns null outside the traffic allocation", () => {
    // Not "control" — a visitor who was never exposed is not a control, and
    // counting them as one biases the experiment.
    expect(assignExperiment(experiment({ traffic_split: 0 }), {}, "visitor-1")).toBeNull();
  });

  it("returns null when targeting excludes the visitor", () => {
    const targeted = experiment({ targeting_rules: { geo: ["DE"] } });
    expect(assignExperiment(targeted, { country: "FR" }, "v1")).toBeNull();
    expect(assignExperiment(targeted, { country: "DE" }, "v1")).not.toBeNull();
  });

  it("returns null with no variations or no visitor id", () => {
    expect(assignExperiment(experiment({ variations: [] }), {}, "v1")).toBeNull();
    expect(assignExperiment(experiment(), {}, "")).toBeNull();
  });

  it("carries the experiment and variation names through", () => {
    const assignment = assignExperiment(
      experiment({ name: "Hero copy", variations: [{ id: "v1", name: "Bold headline" }] }),
      {},
      "visitor-1",
    );
    expect(assignment).toMatchObject({
      experimentName: "Hero copy",
      variationId: "v1",
      variationName: "Bold headline",
    });
  });
});
