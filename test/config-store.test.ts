import { describe, expect, it, jest } from "@jest/globals";
import { ConfigStore } from "../src/config-store.js";
import { silentLogger } from "../src/logger.js";
import { Transport } from "../src/transport.js";
import { config, fakeFetch, flag, tick } from "./helpers.js";

function makeStore(fetch: ReturnType<typeof fakeFetch>, onError = () => {}) {
  const transport = new Transport({
    apiHost: "https://api.spectry.io",
    siteId: "site-1",
    secretKey: "sk_test_abc123",
    fetch: fetch.impl,
    version: "test",
  });
  return new ConfigStore(transport, silentLogger, onError, 1000);
}

describe("ConfigStore", () => {
  it("starts empty and not ready", () => {
    const store = makeStore(fakeFetch());
    expect(store.get()).toBeNull();
    expect(store.ready).toBe(false);
    expect(store.status().flagCount).toBe(0);
  });

  it("fetches and caches the config", async () => {
    const fetch = fakeFetch({ body: config({ flags: [flag({ key: "a" })] }) });
    const store = makeStore(fetch);

    await store.fetch();

    expect(store.ready).toBe(true);
    expect(store.get()?.flags).toHaveLength(1);
    expect(store.status()).toMatchObject({ ready: true, flagCount: 1, consecutiveFailures: 0 });
  });

  it("calls the server SDK config endpoint with the write key", async () => {
    const fetch = fakeFetch();
    await makeStore(fetch).fetch();

    const request = fetch.requests[0]!;
    expect(request.url).toBe("https://api.spectry.io/api/v1/server-sdk/site-1/config");
    expect(request.method).toBe("GET");
    expect(request.headers["authorization"]).toBe("Bearer sk_test_abc123");
  });

  it("sends If-None-Match once it has a version", async () => {
    const fetch = fakeFetch({ body: config(), etag: 'W/"abc"' });
    const store = makeStore(fetch);

    await store.fetch();
    await store.fetch();

    expect(fetch.requests[0]!.headers["if-none-match"]).toBeUndefined();
    expect(fetch.requests[1]!.headers["if-none-match"]).toBe('W/"abc"');
  });

  it("keeps the cached config on a 304", async () => {
    const fetch = fakeFetch({ body: config({ flags: [flag({ key: "a" })] }), etag: 'W/"1"' });
    const store = makeStore(fetch);
    await store.fetch();
    const cached = store.get();

    fetch.queue({ status: 304, etag: 'W/"1"' });
    const after = await store.fetch();

    expect(after).toBe(cached);
    expect(store.get()?.flags).toHaveLength(1);
  });

  it("replaces the config when the version changes", async () => {
    const fetch = fakeFetch({ body: config({ flags: [flag({ key: "old" })] }), etag: 'W/"1"' });
    const store = makeStore(fetch);
    await store.fetch();

    fetch.queue({ body: config({ flags: [flag({ key: "new" })] }), etag: 'W/"2"' });
    await store.fetch();

    expect(store.get()?.flags[0]?.key).toBe("new");
  });

  /**
   * The single most important behaviour here. Dropping the cached config on a
   * failed refresh would flip every feature to its fallback across the entire
   * fleet the moment our API had a bad minute.
   */
  it("serves the last good config when a refresh fails", async () => {
    const fetch = fakeFetch({ body: config({ flags: [flag({ key: "a" })] }) });
    const store = makeStore(fetch);
    await store.fetch();

    fetch.queue({ throws: new Error("network down") });
    await expect(store.fetch()).rejects.toThrow("network down");

    expect(store.ready).toBe(true);
    expect(store.get()?.flags[0]?.key).toBe("a");
    expect(store.status().consecutiveFailures).toBe(1);
  });

  it("resets the failure count after a success", async () => {
    const fetch = fakeFetch();
    const store = makeStore(fetch);

    fetch.queue({ throws: new Error("boom") });
    await expect(store.fetch()).rejects.toThrow();
    expect(store.status().consecutiveFailures).toBe(1);

    await store.fetch();
    expect(store.status().consecutiveFailures).toBe(0);
  });

  it("collapses concurrent fetches into one request", async () => {
    const fetch = fakeFetch();
    const store = makeStore(fetch);

    await Promise.all([store.fetch(), store.fetch(), store.fetch()]);

    // A burst during boot should cost one call, not one per caller.
    expect(fetch.requests).toHaveLength(1);
  });

  it("times out instead of hanging forever", async () => {
    const fetch = fakeFetch({ hang: true });
    const store = makeStore(fetch);

    await expect(store.fetch(30)).rejects.toThrow(/timed out after 30ms/);
  });

  it("surfaces a rejected response as an error", async () => {
    const fetch = fakeFetch({ status: 403, body: { message: "invalid_write_key" } });
    const store = makeStore(fetch);

    await expect(store.fetch()).rejects.toThrow(/403/);
    expect(store.ready).toBe(false);
  });

  describe("polling", () => {
    it("refreshes on the interval", async () => {
      const fetch = fakeFetch();
      const store = makeStore(fetch);
      await store.fetch();
      fetch.reset();

      store.start(20);
      await tick(70);
      store.close();

      expect(fetch.requests.length).toBeGreaterThanOrEqual(2);
    });

    it("does nothing when the interval is zero", async () => {
      const fetch = fakeFetch();
      const store = makeStore(fetch);
      store.start(0);
      await tick(30);
      expect(fetch.requests).toHaveLength(0);
    });

    it("only starts one timer", async () => {
      const fetch = fakeFetch();
      const store = makeStore(fetch);
      await store.fetch();
      fetch.reset();

      store.start(20);
      store.start(20);
      store.start(20);
      await tick(50);
      store.close();

      // Three timers would roughly triple this.
      expect(fetch.requests.length).toBeLessThanOrEqual(3);
    });

    it("stops polling after a permanent rejection", async () => {
      // A bad key will not fix itself; retrying every minute for the life of
      // the process just buries the one message that matters.
      const fetch = fakeFetch({ status: 403, body: { message: "invalid_write_key" } });
      const onError = jest.fn();
      const store = makeStore(fetch, onError);

      store.start(15);
      await tick(60);

      expect(fetch.requests).toHaveLength(1);
      expect(onError).toHaveBeenCalledTimes(1);
      store.close();
    });

    it("keeps polling through a transient failure", async () => {
      const fetch = fakeFetch({ status: 503, body: { message: "unavailable" } });
      const store = makeStore(fetch);

      store.start(15);
      await tick(60);
      store.close();

      expect(fetch.requests.length).toBeGreaterThanOrEqual(2);
    });

    it("reports errors through the onError hook", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const onError = jest.fn();
      const store = makeStore(fetch, onError);

      store.start(15);
      await tick(40);
      store.close();

      expect(onError).toHaveBeenCalled();
      expect((onError.mock.calls[0] as unknown[])[1]).toEqual({ operation: "refresh" });
    });

    it("refuses to restart after close", async () => {
      const fetch = fakeFetch();
      const store = makeStore(fetch);
      store.close();
      store.start(15);
      await tick(40);
      expect(fetch.requests).toHaveLength(0);
    });
  });
});
