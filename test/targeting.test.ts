import { describe, expect, it } from "@jest/globals";
import { matchesTargeting } from "../src/targeting.js";

describe("matchesTargeting", () => {
  it("matches everyone when there are no rules", () => {
    expect(matchesTargeting(undefined, {})).toBe(true);
    expect(matchesTargeting(null, {})).toBe(true);
    expect(matchesTargeting({}, {})).toBe(true);
  });

  it("ignores a malformed rules value rather than excluding everyone", () => {
    expect(matchesTargeting("nonsense" as never, {})).toBe(true);
  });

  it("treats an empty list as no constraint", () => {
    // An empty multi-select in the dashboard means "not filtering on this",
    // not "nobody".
    expect(matchesTargeting({ geo: [] }, {})).toBe(true);
    expect(matchesTargeting({ geo: [], browser: [] }, { country: "DE" })).toBe(true);
  });

  describe("geo", () => {
    it("matches case-insensitively", () => {
      expect(matchesTargeting({ geo: ["DE"] }, { country: "de" })).toBe(true);
      expect(matchesTargeting({ geo: ["de"] }, { country: "DE" })).toBe(true);
      expect(matchesTargeting({ geo: ["DE", "AT"] }, { country: " at " })).toBe(true);
    });

    it("rejects a country outside the list", () => {
      expect(matchesTargeting({ geo: ["DE"] }, { country: "FR" })).toBe(false);
    });

    it("fails closed when the country is unknown", () => {
      // Otherwise a Germany-only flag ships to every visitor whose country we
      // could not resolve, and the rule looks like it is working.
      expect(matchesTargeting({ geo: ["DE"] }, {})).toBe(false);
      expect(matchesTargeting({ geo: ["DE"] }, { country: "" })).toBe(false);
      expect(matchesTargeting({ geo: ["DE"] }, { country: "   " })).toBe(false);
    });
  });

  describe("browser", () => {
    it("matches a listed browser", () => {
      expect(matchesTargeting({ browser: ["chrome"] }, { browser: "Chrome" })).toBe(true);
      expect(matchesTargeting({ browser: ["chrome"] }, { browser: "safari" })).toBe(false);
    });
  });

  describe("device", () => {
    it("accepts the singular spelling the dashboard writes", () => {
      expect(matchesTargeting({ device: ["mobile"] }, { deviceType: "mobile" })).toBe(true);
    });

    it("accepts the plural spelling spectry-js uses", () => {
      expect(matchesTargeting({ devices: ["mobile"] }, { deviceType: "mobile" })).toBe(true);
    });

    it("unions both spellings when both are present", () => {
      const rules = { device: ["mobile"], devices: ["tablet"] };
      expect(matchesTargeting(rules, { deviceType: "tablet" })).toBe(true);
      expect(matchesTargeting(rules, { deviceType: "mobile" })).toBe(true);
      expect(matchesTargeting(rules, { deviceType: "desktop" })).toBe(false);
    });

    it("falls back to a `device` attribute", () => {
      expect(matchesTargeting({ device: ["mobile"] }, { device: "mobile" })).toBe(true);
    });
  });

  describe("userProperty", () => {
    it("matches an exact value", () => {
      expect(
        matchesTargeting({ userProperty: { key: "plan", value: "scale" } }, { plan: "scale" }),
      ).toBe(true);
      expect(
        matchesTargeting({ userProperty: { key: "plan", value: "scale" } }, { plan: "growth" }),
      ).toBe(false);
    });

    it("compares as strings, so 1 and \"1\" agree", () => {
      expect(
        matchesTargeting({ userProperty: { key: "seats", value: "1" } }, { seats: 1 }),
      ).toBe(true);
    });

    it("fails closed when the property is missing or null", () => {
      const rules = { userProperty: { key: "plan", value: "scale" } };
      expect(matchesTargeting(rules, {})).toBe(false);
      expect(matchesTargeting(rules, { plan: null })).toBe(false);
      expect(matchesTargeting(rules, { plan: undefined })).toBe(false);
    });

    it("matches a false value rather than treating it as absent", () => {
      expect(
        matchesTargeting({ userProperty: { key: "beta", value: false } }, { beta: false }),
      ).toBe(true);
    });

    it("ignores a rule with no key", () => {
      expect(matchesTargeting({ userProperty: { key: "", value: "x" } }, {})).toBe(true);
    });
  });

  it("ANDs every rule that is present", () => {
    const rules = { geo: ["DE"], browser: ["chrome"], device: ["mobile"] };
    const full = { country: "DE", browser: "chrome", deviceType: "mobile" };

    expect(matchesTargeting(rules, full)).toBe(true);
    expect(matchesTargeting(rules, { ...full, browser: "safari" })).toBe(false);
    expect(matchesTargeting(rules, { ...full, deviceType: "desktop" })).toBe(false);
    expect(matchesTargeting(rules, { ...full, country: "FR" })).toBe(false);
  });
});
