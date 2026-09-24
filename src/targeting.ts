import type { Attributes, FlagTargetingRules } from "./types.js";

/**
 * Flag and experiment targeting, mirroring `matchesFlagTargeting` in
 * `spectry-api/app/services/feature-flag.service.ts`.
 *
 * Rules are ANDed and an empty rule constrains nothing, so `{ geo: [] }` means
 * "everyone" rather than "no one" — an empty multi-select in the dashboard
 * should not switch a feature off for the whole world.
 */

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((v) => String(v ?? "").trim().toLowerCase())
    .filter((v) => v.length > 0);
}

function inList(allowed: string[], actual: unknown): boolean {
  if (allowed.length === 0) return true;
  const value = String(actual ?? "").trim().toLowerCase();
  // Fail closed. A flag targeted at Germany, evaluated for a user whose country
  // you never set, must not resolve to "matches" — that ships the feature to
  // everyone and the rule looks like it is working.
  if (!value) return false;
  return allowed.includes(value);
}

export function matchesTargeting(
  rules: FlagTargetingRules | null | undefined,
  attributes: Attributes,
): boolean {
  if (!rules || typeof rules !== "object") return true;

  if (!inList(normalizeList(rules.geo), attributes.country)) return false;
  if (!inList(normalizeList(rules.browser), attributes.browser)) return false;

  // The dashboard writes `device`; spectry-js's experiment rules say `devices`.
  // Accepting only one would make half the rules silently match nothing.
  const devices = [...normalizeList(rules.device), ...normalizeList(rules.devices)];
  if (!inList(devices, attributes.deviceType ?? attributes["device"])) return false;

  const prop = rules.userProperty;
  if (prop && prop.key) {
    const actual = attributes[prop.key];
    if (actual === undefined || actual === null) return false;
    if (String(actual) !== String(prop.value)) return false;
  }

  return true;
}
