import { describe, expect, it, jest } from "@jest/globals";
import { SpectryClient } from "../src/client.js";
import { config, experiment, fakeFetch, flag, tick } from "./helpers.js";

function makeClient(
  fetch: ReturnType<typeof fakeFetch>,
  overrides: Record<string, unknown> = {},
) {
  return new SpectryClient({
    siteId: "site-1",
    secretKey: "sk_test_abc123",
    apiHost: "https://api.spectry.io",
    logger: false,
    refreshInterval: 0,
    fetch: fetch.impl,
    ...overrides,
  });
}

describe("SpectryClient", () => {
  describe("construction", () => {
    it("requires a siteId and a secretKey", () => {
      expect(() => new SpectryClient({} as never)).toThrow(/siteId/);
      expect(() => new SpectryClient({ siteId: "s" } as never)).toThrow(/secretKey/);
    });
  });

  describe("init", () => {
    it("loads and caches the config", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch);

      await expect(client.init()).resolves.toBe(true);
      expect(client.ready).toBe(true);
      expect(client.getConfig()?.flags).toHaveLength(1);
      await client.close();
    });

    it("fetches once even when called twice", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch);

      await Promise.all([client.init(), client.init()]);
      await client.init();

      expect(fetch.requests).toHaveLength(1);
      await client.close();
    });

    /**
     * The behaviour that matters most on a bad day: an SDK that stops the host
     * process from booting because our API blinked is worse than one that
     * serves fallbacks for a minute.
     */
    it("does not throw when the first fetch fails", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const client = makeClient(fetch);

      await expect(client.init()).resolves.toBe(false);
      expect(client.ready).toBe(false);
      await client.close();
    });

    it("throws on failure when asked to", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const client = makeClient(fetch);

      await expect(client.init({ throwOnFailure: true })).rejects.toThrow("network down");
      await client.close();
    });

    it("keeps polling after a failed first fetch, so it can recover alone", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const client = makeClient(fetch, { refreshInterval: 20 });

      await client.init();
      expect(client.ready).toBe(false);

      fetch.respondWith({ body: config() });
      await tick(60);

      expect(client.ready).toBe(true);
      await client.close();
    });

    it("honours a per-init timeout", async () => {
      const fetch = fakeFetch({ hang: true });
      const client = makeClient(fetch);

      await expect(client.init({ timeout: 25, throwOnFailure: true })).rejects.toThrow(
        /timed out after 25ms/,
      );
      await client.close();
    });

    it("refuses to init after close", async () => {
      const client = makeClient(fakeFetch());
      await client.close();
      await expect(client.init()).rejects.toThrow(/closed/);
    });
  });

  describe("createScopedInstance", () => {
    it("evaluates flags with no further network calls", async () => {
      const fetch = fakeFetch({ body: config({ flags: [flag({ key: "new-checkout" })] }) });
      const client = makeClient(fetch);
      await client.init();
      fetch.reset();

      const scoped = client.createScopedInstance({ attributes: { id: "user-1" } });

      expect(scoped.isOn("new-checkout")).toBe(true);
      expect(scoped.isOff("new-checkout")).toBe(false);
      // The whole point of caching definitions: reads cost nothing.
      expect(fetch.requests).toHaveLength(0);
      await client.close();
    });

    it("returns the fallback for an unknown flag", async () => {
      const client = makeClient(fakeFetch({ body: config({ flags: [] }) }));
      await client.init();

      const scoped = client.createScopedInstance({ attributes: { id: "user-1" } });
      expect(scoped.getFeatureValue("nope", "fallback")).toBe("fallback");
      expect(scoped.getFeature("nope").source).toBe("unknownFlag");
      await client.close();
    });

    it("serves fallbacks before the config arrives", async () => {
      const fetch = fakeFetch({ hang: true });
      const client = makeClient(fetch);

      const scoped = client.createScopedInstance({ attributes: { id: "user-1" } });
      expect(scoped.ready).toBe(false);
      expect(scoped.isOn("anything")).toBe(false);
      expect(scoped.getFeatureValue("anything", "fallback")).toBe("fallback");
      expect(scoped.getFeature("anything").source).toBe("notReady");
      expect(scoped.getAllFeatures()).toEqual({});
      expect(scoped.getVariation("exp-a")).toBeNull();
      expect(scoped.getExperiments()).toEqual([]);

      await client.close();
    });

    it("sees a config that arrives after the instance was created", async () => {
      const fetch = fakeFetch({ body: config({ flags: [flag({ key: "late" })] }) });
      const client = makeClient(fetch);

      // Instances read through to the client, so one created during boot is
      // not stuck with the empty config it was born with.
      const scoped = client.createScopedInstance({ attributes: { id: "user-1" } });
      expect(scoped.isOn("late")).toBe(false);

      await client.init();
      expect(scoped.isOn("late")).toBe(true);
      await client.close();
    });

    it("uses attributes.id as the bucketing seed", async () => {
      const client = makeClient(
        fakeFetch({ body: config({ flags: [flag({ rollout_percentage: 67 })] }) }),
      );
      await client.init();

      // consistentHash("my-flag", "visitor-1") === 66, so 67 includes them.
      expect(client.createScopedInstance({ attributes: { id: "visitor-1" } }).isOn("my-flag")).toBe(
        true,
      );
      // ...and 74 for visitor-2, which 67 excludes.
      expect(client.createScopedInstance({ attributes: { id: "visitor-2" } }).isOn("my-flag")).toBe(
        false,
      );
      await client.close();
    });

    it("lets an explicit visitorId override attributes.id", async () => {
      const client = makeClient(
        fakeFetch({ body: config({ flags: [flag({ rollout_percentage: 67 })] }) }),
      );
      await client.init();

      const scoped = client.createScopedInstance({
        visitorId: "visitor-1",
        attributes: { id: "visitor-2" },
      });
      expect(scoped.visitorId).toBe("visitor-1");
      expect(scoped.isOn("my-flag")).toBe(true);
      await client.close();
    });

    it("keeps separate users independent", async () => {
      const client = makeClient(fakeFetch({ body: config() }));
      await client.init();

      const a = client.createScopedInstance({ attributes: { id: "a", country: "DE" } });
      const b = client.createScopedInstance({ attributes: { id: "b", country: "FR" } });

      expect(a.attributes.country).toBe("DE");
      expect(b.attributes.country).toBe("FR");
      await client.close();
    });

    it("assigns experiments", async () => {
      const client = makeClient(fakeFetch({ body: config({ experiments: [experiment()] }) }));
      await client.init();

      const scoped = client.createScopedInstance({ attributes: { id: "visitor-1" } });
      const assignment = scoped.getVariation("exp-a");

      expect(assignment).not.toBeNull();
      expect(scoped.getExperiments()).toHaveLength(1);
      expect(scoped.getVariation("does-not-exist")).toBeNull();
      await client.close();
    });
  });

  describe("logEvent", () => {
    it("queues an event with the user's identity and attributes", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch, { eventFlushInterval: 0 });
      await client.init();
      fetch.reset();

      const scoped = client.createScopedInstance({
        sessionId: "sess-1",
        attributes: { id: "user-1", country: "DE", browser: "chrome", deviceType: "mobile", url: "/checkout" },
      });
      scoped.logEvent("Payment Accepted", { amount: 49 });
      await client.flush();

      expect(fetch.requests[0]!.body).toEqual({
        events: [
          {
            name: "Payment Accepted",
            properties: { amount: 49 },
            visitorId: "user-1",
            sessionId: "sess-1",
            url: "/checkout",
            attributes: { country: "DE", browser: "chrome", deviceType: "mobile" },
          },
        ],
      });
      await client.close();
    });

    it("works without properties", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch, { eventFlushInterval: 0 });
      await client.init();
      fetch.reset();

      client.createScopedInstance({ attributes: { id: "u" } }).logEvent("Signed Up");
      await client.flush();

      const event = (fetch.requests[0]!.body as { events: Array<Record<string, unknown>> }).events[0]!;
      expect(event["name"]).toBe("Signed Up");
      expect(event).not.toHaveProperty("properties");
      await client.close();
    });

    it("ignores an empty name instead of sending junk", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch, { eventFlushInterval: 0 });
      await client.init();
      fetch.reset();

      const scoped = client.createScopedInstance({ attributes: { id: "u" } });
      scoped.logEvent("");
      scoped.logEvent("   ");
      await client.flush();

      expect(fetch.requests).toHaveLength(0);
      await client.close();
    });

    it("never throws, even with the network down", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const client = makeClient(fetch, { eventFlushInterval: 0 });
      await client.init();

      const scoped = client.createScopedInstance({ attributes: { id: "u" } });
      expect(() => scoped.logEvent("Payment Accepted")).not.toThrow();
      await expect(scoped.flush()).resolves.toBeUndefined();
      await client.close();
    });

    it("batches events from several users into one request", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch, { eventFlushInterval: 0 });
      await client.init();
      fetch.reset();

      client.createScopedInstance({ attributes: { id: "a" } }).logEvent("e1");
      client.createScopedInstance({ attributes: { id: "b" } }).logEvent("e2");
      await client.flush();

      expect(fetch.requests).toHaveLength(1);
      expect((fetch.requests[0]!.body as { events: unknown[] }).events).toHaveLength(2);
      await client.close();
    });
  });

  describe("refresh", () => {
    it("picks up a changed config", async () => {
      const fetch = fakeFetch({ body: config({ flags: [flag({ key: "old" })] }), etag: 'W/"1"' });
      const client = makeClient(fetch);
      await client.init();

      fetch.queue({ body: config({ flags: [flag({ key: "new" })] }), etag: 'W/"2"' });
      await expect(client.refresh()).resolves.toBe(true);

      expect(client.getConfig()?.flags[0]?.key).toBe("new");
      await client.close();
    });

    it("reports a failure without throwing", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch);
      await client.init();

      fetch.queue({ throws: new Error("network down") });
      await expect(client.refresh()).resolves.toBe(false);
      // Still serving the last good config.
      expect(client.ready).toBe(true);
      await client.close();
    });
  });

  describe("getStatus", () => {
    it("describes the cache and the queue", async () => {
      const fetch = fakeFetch({ body: config({ flags: [flag()], experiments: [experiment()] }) });
      const client = makeClient(fetch, { eventFlushInterval: 0 });
      await client.init();

      client.createScopedInstance({ attributes: { id: "u" } }).logEvent("queued");

      expect(client.getStatus()).toMatchObject({
        ready: true,
        flagCount: 1,
        experimentCount: 1,
        consecutiveFailures: 0,
        queuedEvents: 1,
      });
      await client.close();
    });

    it("reports the config version and the SDK version separately", async () => {
      // Reporting only one of them reported the less useful one: `version` is
      // what tells you whether a flag change has landed.
      const client = makeClient(fakeFetch({ body: config(), etag: 'W/"abc"' }));
      await client.init();

      const status = client.getStatus();
      expect(status.version).toBe('W/"v1"');
      expect(status.sdkVersion).toMatch(/^\d+\.\d+\.\d+$/);
      await client.close();
    });
  });

  describe("close", () => {
    it("flushes queued events", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch, { eventFlushInterval: 0 });
      await client.init();
      fetch.reset();

      client.createScopedInstance({ attributes: { id: "u" } }).logEvent("last");
      await client.close();

      expect(fetch.requests).toHaveLength(1);
    });

    it("stops the refresh timer", async () => {
      const fetch = fakeFetch({ body: config() });
      const client = makeClient(fetch, { refreshInterval: 20 });
      await client.init();
      await client.close();
      fetch.reset();

      await tick(60);
      expect(fetch.requests).toHaveLength(0);
    });

    it("is safe to call twice", async () => {
      const client = makeClient(fakeFetch({ body: config() }));
      await client.init();
      await client.close();
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe("error reporting", () => {
    it("routes swallowed errors to onError", async () => {
      const onError = jest.fn();
      const fetch = fakeFetch({ throws: new Error("network down") });
      const client = makeClient(fetch, { refreshInterval: 20, onError });

      await client.init();
      await tick(50);
      await client.close();

      expect(onError).toHaveBeenCalled();
    });
  });
});
