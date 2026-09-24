import { describe, expect, it, jest } from "@jest/globals";
import { EventQueue } from "../src/events.js";
import { silentLogger } from "../src/logger.js";
import { Transport } from "../src/transport.js";
import { fakeFetch, tick } from "./helpers.js";

function makeQueue(
  fetch: ReturnType<typeof fakeFetch>,
  overrides: Partial<{
    batchSize: number;
    flushInterval: number;
    maxQueued: number;
    timeout: number;
  }> = {},
  onError: (error: Error, context: { operation: string }) => void = () => {},
) {
  const transport = new Transport({
    apiHost: "https://api.spectry.io",
    siteId: "site-1",
    secretKey: "sk_test_abc123",
    fetch: fetch.impl,
    version: "test",
  });
  return new EventQueue(transport, silentLogger, onError, {
    batchSize: 25,
    flushInterval: 5000,
    maxQueued: 1000,
    timeout: 1000,
    ...overrides,
  });
}

describe("EventQueue", () => {
  it("buffers without sending", () => {
    const fetch = fakeFetch({ body: { success: true } });
    const queue = makeQueue(fetch);

    queue.enqueue({ name: "a" });
    queue.enqueue({ name: "b" });

    expect(queue.size).toBe(2);
    expect(fetch.requests).toHaveLength(0);
  });

  it("posts a batch to the events endpoint", async () => {
    const fetch = fakeFetch({ body: { success: true } });
    const queue = makeQueue(fetch);

    queue.enqueue({ name: "Payment Accepted", properties: { amount: 49 } });
    await queue.flush();

    const request = fetch.requests[0]!;
    expect(request.url).toBe("https://api.spectry.io/api/v1/server-sdk/site-1/events");
    expect(request.method).toBe("POST");
    expect(request.headers["authorization"]).toBe("Bearer sk_test_abc123");
    expect(request.body).toEqual({
      events: [{ name: "Payment Accepted", properties: { amount: 49 } }],
    });
    expect(queue.size).toBe(0);
  });

  it("flushes as soon as the batch is full", async () => {
    const fetch = fakeFetch({ body: { success: true } });
    const queue = makeQueue(fetch, { batchSize: 3 });

    queue.enqueue({ name: "a" });
    queue.enqueue({ name: "b" });
    expect(fetch.requests).toHaveLength(0);

    queue.enqueue({ name: "c" });
    await tick(5);

    expect(fetch.requests).toHaveLength(1);
    expect((fetch.requests[0]!.body as { events: unknown[] }).events).toHaveLength(3);
  });

  it("flushes on the interval", async () => {
    const fetch = fakeFetch({ body: { success: true } });
    const queue = makeQueue(fetch, { flushInterval: 20 });

    queue.enqueue({ name: "a" });
    expect(fetch.requests).toHaveLength(0);

    await tick(50);
    expect(fetch.requests).toHaveLength(1);
  });

  it("splits a large backlog across requests", async () => {
    const fetch = fakeFetch({ body: { success: true } });
    const queue = makeQueue(fetch, { batchSize: 10, flushInterval: 0 });

    for (let i = 0; i < 25; i++) queue.enqueue({ name: `e-${i}` });
    await queue.flush();

    expect(fetch.requests).toHaveLength(3);
    expect(queue.size).toBe(0);
  });

  it("does nothing when there is nothing queued", async () => {
    const fetch = fakeFetch({ body: { success: true } });
    await makeQueue(fetch).flush();
    expect(fetch.requests).toHaveLength(0);
  });

  it("never throws out of enqueue", () => {
    const fetch = fakeFetch({ throws: new Error("network down") });
    const queue = makeQueue(fetch, { batchSize: 1 });
    // Called from a request handler on someone's checkout path.
    expect(() => queue.enqueue({ name: "a" })).not.toThrow();
  });

  describe("failure handling", () => {
    it("re-queues a batch after a transient failure", async () => {
      const fetch = fakeFetch({ body: { success: true } });
      const queue = makeQueue(fetch, { flushInterval: 0 });

      queue.enqueue({ name: "a" });
      fetch.queue({ status: 503, body: { message: "unavailable" } });
      await queue.flush();

      expect(queue.size).toBe(1);

      await queue.flush();
      expect(queue.size).toBe(0);
      expect(fetch.requests).toHaveLength(2);
    });

    it("drops a permanently rejected batch instead of retrying forever", async () => {
      // A 403 is a bad key and a 400 is a malformed body. Re-queueing either
      // retries the same failure forever and blocks every later event.
      const fetch = fakeFetch({ status: 403, body: { message: "invalid_write_key" } });
      const queue = makeQueue(fetch, { flushInterval: 0 });

      queue.enqueue({ name: "a" });
      await queue.flush();

      expect(queue.size).toBe(0);
    });

    it("retries a 429 rather than dropping it", async () => {
      const fetch = fakeFetch({ status: 429, body: { message: "slow down" } });
      const queue = makeQueue(fetch, { flushInterval: 0 });

      queue.enqueue({ name: "a" });
      await queue.flush();

      expect(queue.size).toBe(1);
    });

    it("reports failures through onError", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const onError = jest.fn();
      const queue = makeQueue(fetch, { flushInterval: 0 }, onError);

      queue.enqueue({ name: "a" });
      await queue.flush();

      expect(onError).toHaveBeenCalled();
      expect((onError.mock.calls[0] as unknown[])[1]).toEqual({ operation: "flush" });
    });

    it("stops draining after a failed batch instead of hammering through the backlog", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const queue = makeQueue(fetch, { batchSize: 2, flushInterval: 0 });

      for (let i = 0; i < 6; i++) queue.enqueue({ name: `e-${i}` });
      // Filling a batch triggers its own flush, so let those settle before
      // measuring a single deliberate one.
      await tick(5);
      fetch.reset();

      await queue.flush();

      // One request, not three: a dead network should cost one attempt per
      // flush, not one per queued batch.
      expect(fetch.requests).toHaveLength(1);
      // And nothing was lost along the way.
      expect(queue.size).toBe(6);
    });

    it("delivers a re-queued batch once the network recovers", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const queue = makeQueue(fetch, { batchSize: 10, flushInterval: 0 });

      queue.enqueue({ name: "a" });
      queue.enqueue({ name: "b" });
      await queue.flush();
      expect(queue.size).toBe(2);

      fetch.respondWith({ body: { success: true } });
      await queue.flush();

      expect(queue.size).toBe(0);
      const delivered = (fetch.requests.at(-1)!.body as { events: Array<{ name: string }> }).events;
      expect(delivered.map((e) => e.name)).toEqual(["a", "b"]);
    });
  });

  describe("bounded queue", () => {
    it("drops the oldest events past the ceiling", () => {
      // An unbounded queue turns an API outage into the host process running
      // out of memory.
      const fetch = fakeFetch({ body: { success: true } });
      const queue = makeQueue(fetch, { maxQueued: 3, batchSize: 100, flushInterval: 0 });

      for (let i = 0; i < 6; i++) queue.enqueue({ name: `e-${i}` });

      expect(queue.size).toBe(3);
    });

    it("keeps the newest events when it drops", async () => {
      const fetch = fakeFetch({ body: { success: true } });
      const queue = makeQueue(fetch, { maxQueued: 2, batchSize: 100, flushInterval: 0 });

      queue.enqueue({ name: "oldest" });
      queue.enqueue({ name: "middle" });
      queue.enqueue({ name: "newest" });
      await queue.flush();

      const names = (fetch.requests[0]!.body as { events: Array<{ name: string }> }).events.map(
        (e) => e.name,
      );
      expect(names).toEqual(["middle", "newest"]);
    });

    it("does not grow past the ceiling when re-queueing a failed batch", async () => {
      const fetch = fakeFetch({ body: { success: true } });
      const queue = makeQueue(fetch, { maxQueued: 4, batchSize: 4, flushInterval: 0 });

      for (let i = 0; i < 4; i++) queue.enqueue({ name: `e-${i}` });
      fetch.queue({ throws: new Error("network down") });
      await queue.flush();

      expect(queue.size).toBeLessThanOrEqual(4);
    });
  });

  describe("close", () => {
    it("flushes what is left", async () => {
      const fetch = fakeFetch({ body: { success: true } });
      const queue = makeQueue(fetch, { flushInterval: 0 });

      queue.enqueue({ name: "last" });
      await queue.close();

      expect(fetch.requests).toHaveLength(1);
      expect(queue.size).toBe(0);
    });

    it("refuses new events afterwards", async () => {
      const fetch = fakeFetch({ body: { success: true } });
      const queue = makeQueue(fetch, { flushInterval: 0 });

      await queue.close();
      queue.enqueue({ name: "too-late" });

      expect(queue.size).toBe(0);
    });

    it("survives a failing final flush", async () => {
      const fetch = fakeFetch({ throws: new Error("network down") });
      const queue = makeQueue(fetch, { flushInterval: 0 });
      queue.enqueue({ name: "a" });
      await expect(queue.close()).resolves.toBeUndefined();
    });
  });
});
