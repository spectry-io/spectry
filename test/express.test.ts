import { describe, expect, it, jest } from "@jest/globals";
import { SpectryClient } from "../src/client.js";
import { attributesFromRequest, spectryMiddleware } from "../src/express.js";
import type { ScopedSpectry } from "../src/scoped.js";
import { config, fakeFetch, flag } from "./helpers.js";

const UA = {
  chromeDesktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 Edg/125.0",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
};

function makeRes() {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    on(event: string, listener: () => void) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    emit(event: string) {
      for (const listener of listeners[event] ?? []) listener();
    },
  };
}

describe("spectryMiddleware", () => {
  it("attaches a scoped instance and calls next", async () => {
    const client = new SpectryClient({
      siteId: "site-1",
      secretKey: "sk_test_abc123",
      logger: false,
      refreshInterval: 0,
      fetch: fakeFetch({ body: config({ flags: [flag({ key: "beta" })] }) }).impl,
    });
    await client.init();

    const middleware = spectryMiddleware(client, {
      context: (req) => ({ attributes: { id: String(req["userId"]) } }),
    });

    const req: Record<string, unknown> = { userId: "user-1" };
    const next = jest.fn();
    middleware(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req["spectry"] as ScopedSpectry).isOn("beta")).toBe(true);
    await client.close();
  });

  it("honours a custom property name", async () => {
    const client = new SpectryClient({
      siteId: "s",
      secretKey: "k",
      logger: false,
      refreshInterval: 0,
      fetch: fakeFetch({ body: config() }).impl,
    });
    await client.init();

    const req: Record<string, unknown> = {};
    spectryMiddleware(client, { context: () => ({}), property: "flags" })(req, makeRes(), () => {});

    expect(req["flags"]).toBeDefined();
    expect(req["spectry"]).toBeUndefined();
    await client.close();
  });

  /**
   * Analytics must never be the reason a request 500s.
   */
  it("calls next even when the context builder throws", async () => {
    const client = new SpectryClient({
      siteId: "s",
      secretKey: "k",
      logger: false,
      refreshInterval: 0,
      fetch: fakeFetch({ body: config() }).impl,
    });
    await client.init();

    const next = jest.fn();
    const req: Record<string, unknown> = {};
    spectryMiddleware(client, {
      context: () => {
        throw new Error("no user on request");
      },
    })(req, makeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req["spectry"]).toBeUndefined();
    await client.close();
  });

  it("flushes on response finish when asked", async () => {
    const fetch = fakeFetch({ body: config() });
    const client = new SpectryClient({
      siteId: "s",
      secretKey: "k",
      logger: false,
      refreshInterval: 0,
      eventFlushInterval: 0,
      fetch: fetch.impl,
    });
    await client.init();
    fetch.reset();

    const req: Record<string, unknown> = {};
    const res = makeRes();
    spectryMiddleware(client, {
      context: () => ({ attributes: { id: "u" } }),
      flushOnResponse: true,
    })(req, res, () => {});

    (req["spectry"] as ScopedSpectry).logEvent("Viewed");
    res.emit("finish");
    await new Promise((r) => setTimeout(r, 5));

    // Matters on serverless, where the process can be frozen the moment the
    // response is sent and an unflushed queue dies with it.
    expect(fetch.requests).toHaveLength(1);
    await client.close();
  });

  it("does not subscribe to finish unless asked", async () => {
    const client = new SpectryClient({
      siteId: "s",
      secretKey: "k",
      logger: false,
      refreshInterval: 0,
      fetch: fakeFetch({ body: config() }).impl,
    });
    await client.init();

    const res = { on: jest.fn() };
    spectryMiddleware(client, { context: () => ({}) })({}, res as never, () => {});

    expect(res.on).not.toHaveBeenCalled();
    await client.close();
  });
});

describe("attributesFromRequest", () => {
  it("pulls url, path and host off the request", () => {
    const attributes = attributesFromRequest({
      originalUrl: "/pricing?utm_source=newsletter",
      path: "/pricing",
      hostname: "example.com",
      headers: {},
    });

    expect(attributes).toMatchObject({
      url: "/pricing?utm_source=newsletter",
      path: "/pricing",
      host: "example.com",
    });
  });

  it("falls back to the Host header", () => {
    expect(attributesFromRequest({ headers: { host: "fallback.example" } }).host).toBe(
      "fallback.example",
    );
  });

  it("camelCases UTM parameters and skips the empty ones", () => {
    const attributes = attributesFromRequest({
      headers: {},
      query: { utm_source: "newsletter", utm_medium: "", utm_campaign: "spring" },
    });

    expect(attributes["utmSource"]).toBe("newsletter");
    expect(attributes["utmCampaign"]).toBe("spring");
    expect(attributes).not.toHaveProperty("utmMedium");
  });

  describe("device detection", () => {
    it.each([
      [UA.chromeDesktop, "desktop"],
      [UA.safariIphone, "mobile"],
      [UA.safariIpad, "tablet"],
      // Android without "Mobile" is a tablet — the usual trap.
      [UA.androidTablet, "tablet"],
    ])("classifies %#", (userAgent, expected) => {
      expect(attributesFromRequest({ headers: { "user-agent": userAgent } }).deviceType).toBe(
        expected,
      );
    });

    it("is blank with no User-Agent, so a device rule fails closed", () => {
      expect(attributesFromRequest({ headers: {} }).deviceType).toBe("");
    });
  });

  describe("browser detection", () => {
    it.each([
      [UA.chromeDesktop, "chrome"],
      [UA.safariIphone, "safari"],
      // Edge and Opera both claim to be Chrome; Chrome claims to be Safari.
      [UA.edge, "edge"],
      [UA.firefox, "firefox"],
    ])("classifies %#", (userAgent, expected) => {
      expect(attributesFromRequest({ headers: { "user-agent": userAgent } }).browser).toBe(
        expected,
      );
    });
  });

  it("copes with an array-valued header", () => {
    const attributes = attributesFromRequest({
      headers: { "user-agent": [UA.firefox] },
    });
    expect(attributes.browser).toBe("firefox");
  });

  it("never throws on an empty request", () => {
    expect(() => attributesFromRequest({})).not.toThrow();
  });
});
