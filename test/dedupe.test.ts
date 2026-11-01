import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { createMemoryStore, createSqliteStore, type DedupeStore } from "../src/dedupe.ts";

const meta = { topic: "orders/create", shopDomain: "harbour-pine-demo.myshopify.com" };

type Factory = (clock: { t: number }, lockTimeoutMs?: number) => DedupeStore;
const factories: Array<[string, Factory]> = [
  ["memory store", (clock, lockTimeoutMs) => createMemoryStore({ now: () => clock.t, ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}) })],
  ["sqlite store", (clock, lockTimeoutMs) => createSqliteStore({ db: openDb(), now: () => clock.t, ...(lockTimeoutMs !== undefined ? { lockTimeoutMs } : {}) })],
];

describe.each(factories)("%s", (_name, make) => {
  it("claims a new key once, then reports it in flight", async () => {
    const store = make({ t: 1000 });
    expect(await store.claim("a", meta)).toBe("claimed");
    expect(await store.claim("a", meta)).toBe("in_flight");
  });

  it("reports done after complete, forever", async () => {
    const clock = { t: 1000 };
    const store = make(clock, 10);
    await store.claim("a", meta);
    await store.complete("a");
    clock.t += 1_000_000;
    expect(await store.claim("a", meta)).toBe("done");
  });

  it("lets a failed key be claimed again", async () => {
    const store = make({ t: 1000 });
    await store.claim("a", meta);
    await store.fail("a", "boom");
    expect(await store.claim("a", meta)).toBe("claimed");
  });

  it("does not let fail() undo done", async () => {
    const store = make({ t: 1000 });
    await store.claim("a", meta);
    await store.complete("a");
    await store.fail("a", "late failure report");
    expect(await store.claim("a", meta)).toBe("done");
  });

  it("takes over a claim older than the lock timeout, but not one at or inside it", async () => {
    const clock = { t: 10_000 };
    const store = make(clock, 5_000);
    await store.claim("a", meta);
    clock.t += 5_000;
    expect(await store.claim("a", meta)).toBe("in_flight");
    clock.t += 1;
    expect(await store.claim("a", meta)).toBe("claimed");
    // and the new owner now holds a fresh lock
    expect(await store.claim("a", meta)).toBe("in_flight");
  });

  it("keeps keys independent", async () => {
    const store = make({ t: 1 });
    expect(await store.claim("a", meta)).toBe("claimed");
    expect(await store.claim("b", meta)).toBe("claimed");
    await store.complete("a");
    expect(await store.claim("b", meta)).toBe("in_flight");
  });

  it("lets exactly one of many simultaneous claims win", async () => {
    const store = make({ t: 1 });
    const results = await Promise.all(Array.from({ length: 50 }, () => store.claim("same", meta)));
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "in_flight")).toHaveLength(49);
  });

  it("tolerates complete() and fail() on a key that was never claimed", async () => {
    const store = make({ t: 1 });
    await expect(store.fail("ghost", "x")).resolves.toBeUndefined();
    await expect(store.complete("ghost")).resolves.toBeUndefined();
    expect(await store.claim("ghost", meta)).toBe("claimed"); // neither call invented a record
  });
});

describe("sqlite store persistence", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("remembers done keys across a restart (a fresh connection to the same file)", async () => {
    dir = mkdtempSync(join(tmpdir(), "shopify-kit-dedupe-"));
    const file = join(dir, "app.db");
    const first = openDb(file);
    const storeA = createSqliteStore({ db: first });
    await storeA.claim("delivery-1", meta);
    await storeA.complete("delivery-1");
    first.close();
    const second = openDb(file);
    const storeB = createSqliteStore({ db: second });
    expect(await storeB.claim("delivery-1", meta)).toBe("done");
    second.close();
  });

  it("stores the failure text, truncated, and the topic and shop for debugging", async () => {
    const db = openDb();
    const store = createSqliteStore({ db });
    await store.claim("k", meta);
    await store.fail("k", "x".repeat(2000));
    const row = db.prepare("SELECT status, topic, shop_domain, error FROM processed_webhooks WHERE key = 'k'").get() as { status: string; topic: string; shop_domain: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.topic).toBe("orders/create");
    expect(row.shop_domain).toBe("harbour-pine-demo.myshopify.com");
    expect(row.error).toHaveLength(500);
  });

  it("clears the stored error when a failed key is claimed again and then completes", async () => {
    const db = openDb();
    const store = createSqliteStore({ db });
    await store.claim("k", meta);
    await store.fail("k", "first try");
    await store.claim("k", meta);
    await store.complete("k");
    const row = db.prepare("SELECT status, error FROM processed_webhooks WHERE key = 'k'").get() as { status: string; error: string | null };
    expect(row).toEqual({ status: "done", error: null });
  });
});
