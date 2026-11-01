import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_DUE_MS, createSqliteCompliance } from "../src/compliance.ts";
import { openDb, type Db } from "../src/db.ts";
import { createMemoryStore, createSqliteStore, type DedupeStore } from "../src/dedupe.ts";
import { createOrderHandlers } from "../src/handlers.ts";
import { PayloadError, getHeader, handleShopifyWebhook, parseJsonKeepingBigIds, type WebhookContext, type WebhookOptions } from "../src/webhooks.ts";
import { customerRedactPayload, dataRequestPayload, orderPayload, refundPayload, shopRedactPayload, SHOP_DOMAIN } from "../testing/payloads.ts";
import { TEST_SECRET, delivery } from "../testing/sign.ts";

function setupWith(over: Partial<WebhookOptions> = {}, store: DedupeStore | undefined, spyOnCreate: boolean) {
  const db = openDb();
  const calls: WebhookContext[] = [];
  const real = createOrderHandlers(db);
  const options: WebhookOptions = {
    secrets: TEST_SECRET,
    store: store ?? createSqliteStore({ db }),
    compliance: createSqliteCompliance(db),
    now: () => 1_800_000_000_000,
    ...over,
    handlers: { ...real, ...(spyOnCreate ? { "orders/create": (ctx: WebhookContext) => { calls.push(ctx); } } : {}), ...(over.handlers ?? {}) },
  };
  return { db, calls, options, send: (d: { rawBody: unknown; headers: Record<string, string> }) => handleShopifyWebhook(d as { rawBody: string; headers: Record<string, string> }, options) };
}

const setup = (over: Partial<WebhookOptions> = {}, store?: DedupeStore, spyOnCreate = true) => setupWith(over, store, spyOnCreate);

const count = (db: Db, table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("verification", () => {
  it("accepts a correctly signed delivery and passes the parsed payload and headers to the handler", async () => {
    const { calls, send } = setup();
    const d = delivery(orderPayload(), { topic: "orders/create", webhookId: "w-1", eventId: "e-1" });
    const r = await send(d);
    expect(r).toMatchObject({ status: 200, body: { received: true, status: "processed" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ topic: "orders/create", shopDomain: SHOP_DOMAIN, webhookId: "w-1", eventId: "e-1", apiVersion: "2026-10", triggeredAt: "2026-10-30T16:00:05.123456789Z" });
    expect((calls[0]!.payload as { name: string }).name).toBe("#1001");
    expect(calls[0]!.rawBody).toBe(d.rawBody);
  });

  it("returns 401 for a wrong signature, a missing signature, and a body changed after signing; the handler never runs", async () => {
    const { calls, db, send } = setup();
    const good = delivery(orderPayload(), { topic: "orders/create" });
    const wrongSecret = delivery(orderPayload(), { topic: "orders/create", secret: "someone else's secret" });
    const { "x-shopify-hmac-sha256": _drop, ...noHmacHeaders } = good.headers;
    expect(await send(wrongSecret)).toMatchObject({ status: 401, body: { error: "invalid_hmac" } });
    expect(await send({ rawBody: good.rawBody, headers: noHmacHeaders })).toMatchObject({ status: 401 });
    expect(await send({ rawBody: good.rawBody.replace("63.85", "0.01"), headers: good.headers })).toMatchObject({ status: 401 });
    expect(calls).toHaveLength(0);
    expect(count(db, "processed_webhooks")).toBe(0);
  });

  it("checks the signature before parsing: a forged non-JSON body gets 401, not 400", async () => {
    const { send } = setup();
    const d = delivery({}, { topic: "orders/create", rawBody: "not json", secret: "wrong" });
    expect((await send(d)).status).toBe(401);
  });

  it("refuses an already-parsed body (the signature can no longer be checked)", async () => {
    const { calls, send } = setup();
    const d = delivery(orderPayload(), { topic: "orders/create" });
    const r = await send({ rawBody: JSON.parse(d.rawBody), headers: d.headers });
    expect(r).toMatchObject({ status: 400, body: { error: "body_not_raw" } });
    expect(calls).toHaveLength(0);
  });

  it("verifies the exact bytes: a parse-and-reserialise receiver rejects valid deliveries that this one accepts", async () => {
    const { send } = setup();
    // Shopify signs whatever bytes it sends; here pretty-printed JSON, and a large id that does not survive JSON.parse
    const raw = '{\n "id": 820982911946154508,\n "name": "#9999",\n "updated_at": "2026-10-30T14:00:05Z"\n}';
    const d = delivery(null, { topic: "orders/create", rawBody: raw });
    const naive = (body: string, header: string): boolean => createHmac("sha256", TEST_SECRET).update(JSON.stringify(JSON.parse(body))).digest("base64") === header;
    expect(naive(raw, d.headers["x-shopify-hmac-sha256"]!)).toBe(false); // what express.json() + JSON.stringify would conclude
    expect(await send(d)).toMatchObject({ status: 200 });
  });

  it("rotates secrets: a delivery signed with the previous secret is accepted while both are configured", async () => {
    const { send } = setup({ secrets: ["new_secret_value", TEST_SECRET] });
    expect((await send(delivery(orderPayload(), { topic: "orders/create" }))).status).toBe(200);
    const { send: sendOnlyNew } = setup({ secrets: "new_secret_value" });
    expect((await sendOnlyNew(delivery(orderPayload(), { topic: "orders/create" }))).status).toBe(401);
  });

  it("accepts the body as bytes and the headers as a Headers object, any capitalisation", async () => {
    const { calls, options } = setup();
    const d = delivery(orderPayload(), { topic: "orders/create" });
    const headers = new Headers();
    for (const [k, v] of Object.entries(d.headers)) headers.set(k.toUpperCase(), v);
    const r = await handleShopifyWebhook({ rawBody: new TextEncoder().encode(d.rawBody), headers }, options);
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("treats a repeated HMAC header as ambiguous and rejects it", async () => {
    const { options } = setup();
    const d = delivery(orderPayload(), { topic: "orders/create" });
    const { "x-shopify-hmac-sha256": hmac, ...rest } = d.headers;
    const r = await handleShopifyWebhook({ rawBody: d.rawBody, headers: { ...rest, "X-Shopify-Hmac-Sha256": [hmac!, hmac!] } }, options);
    expect(r.status).toBe(401);
  });

  it("getHeader is case-insensitive for plain objects and Headers", () => {
    expect(getHeader({ "X-Shopify-Topic": "orders/create" }, "x-shopify-topic")).toBe("orders/create");
    expect(getHeader(new Headers({ "x-shopify-topic": "a" }), "X-Shopify-Topic")).toBe("a");
    expect(getHeader({}, "x")).toBeUndefined();
  });
});

describe("request validation after the signature passes", () => {
  it.each([
    ["missing topic", { "x-shopify-topic": "" }, "missing_topic"],
    ["invalid shop domain", { "x-shopify-shop-domain": "evil.example" }, "invalid_shop_domain"],
    ["shop domain with a suffix", { "x-shopify-shop-domain": `${SHOP_DOMAIN}.attacker.example` }, "invalid_shop_domain"],
    ["missing webhook id", { "x-shopify-webhook-id": "" }, "missing_webhook_id"],
  ])("answers 400 for %s", async (_name, headerOverride, error) => {
    const { calls, send } = setup();
    const d = delivery(orderPayload(), { topic: "orders/create" });
    const r = await send({ rawBody: d.rawBody, headers: { ...d.headers, ...headerOverride } });
    expect(r).toMatchObject({ status: 400, body: { error } });
    expect(calls).toHaveLength(0);
  });

  it("answers 400 for a validly signed body that is not JSON, or not UTF-8", async () => {
    const { send } = setup();
    expect(await send(delivery(null, { topic: "orders/create", rawBody: "{oops" }))).toMatchObject({ status: 400, body: { error: "invalid_json" } });
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const headers = delivery(null, { topic: "orders/create", rawBody: "x" }).headers;
    headers["x-shopify-hmac-sha256"] = createHmac("sha256", TEST_SECRET).update(bytes).digest("base64");
    const { options } = setup();
    expect(await handleShopifyWebhook({ rawBody: bytes, headers }, options)).toMatchObject({ status: 400, body: { error: "invalid_body" } });
  });

  it("acknowledges a topic nobody handles with 200 and does not record it as processed", async () => {
    const { db, send } = setup();
    const r = await send(delivery({ id: 1 }, { topic: "products/update" }));
    expect(r).toMatchObject({ status: 200, body: { status: "ignored" } });
    expect(count(db, "processed_webhooks")).toBe(0);
  });

  it("lower-cases the shop domain it hands to handlers", async () => {
    const { calls, send } = setup();
    await send(delivery(orderPayload(), { topic: "orders/create", shop: "Harbour-Pine-Demo.myshopify.com" }));
    expect(calls[0]!.shopDomain).toBe(SHOP_DOMAIN);
  });
});

describe("duplicates", () => {
  it("runs the handler once for the same webhook id and answers 200 duplicate afterwards", async () => {
    const { calls, send } = setup();
    const d = delivery(orderPayload(), { topic: "orders/create", webhookId: "same" });
    expect((await send(d)).body).toMatchObject({ status: "processed" });
    expect((await send(d)).body).toMatchObject({ status: "duplicate" });
    expect((await send(d)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("by default treats two webhook ids carrying the same event id as two deliveries (the documented key is the webhook id)", async () => {
    const { calls, send } = setup();
    await send(delivery(orderPayload(), { topic: "orders/create", webhookId: "w-a", eventId: "event-1" }));
    await send(delivery(orderPayload(), { topic: "orders/create", webhookId: "w-b", eventId: "event-1" }));
    expect(calls).toHaveLength(2);
  });

  it("with dedupeBy event-id-and-topic, collapses the duplicate subscription but not a different topic", async () => {
    const { calls, send } = setup({ dedupeBy: "event-id-and-topic", handlers: { "orders/updated": (ctx) => { calls.push(ctx); } } });
    await send(delivery(orderPayload(), { topic: "orders/create", webhookId: "w-a", eventId: "event-1" }));
    const second = await send(delivery(orderPayload(), { topic: "orders/create", webhookId: "w-b", eventId: "event-1" }));
    expect(second.body).toMatchObject({ status: "duplicate" });
    await send(delivery(orderPayload(), { topic: "orders/updated", webhookId: "w-c", eventId: "event-1" }));
    expect(calls).toHaveLength(2);
  });

  it("with dedupeBy event-id-and-topic, a delivery without an event id is a 400", async () => {
    const { send } = setup({ dedupeBy: "event-id-and-topic" });
    const d = delivery(orderPayload(), { topic: "orders/create" });
    expect(await send({ rawBody: d.rawBody, headers: { ...d.headers, "x-shopify-event-id": "" } })).toMatchObject({ status: 400, body: { error: "missing_event_id" } });
  });

  it("answers 409 while the same delivery is still being processed, then duplicate once it finished", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let runs = 0;
    const { send } = setup({ handlers: { "orders/create": async () => { runs++; await gate; } } });
    const d = delivery(orderPayload(), { topic: "orders/create", webhookId: "slow" });
    const first = send(d);
    await new Promise((r) => setTimeout(r, 10));
    expect(await send(d)).toMatchObject({ status: 409, body: { status: "in_flight" } });
    release();
    expect((await first).status).toBe(200);
    expect((await send(d)).body).toMatchObject({ status: "duplicate" });
    expect(runs).toBe(1);
  });

  it("works the same on the in-memory store", async () => {
    const { calls, send } = setup({}, createMemoryStore());
    const d = delivery(orderPayload(), { topic: "orders/create", webhookId: "mem" });
    await send(d);
    await send(d);
    expect(calls).toHaveLength(1);
  });
});

describe("failures and retries", () => {
  it("answers 500 when the handler throws, and the retry with the same webhook id runs it again", async () => {
    let attempts = 0;
    const { send } = setup({ handlers: { "orders/create": () => { if (++attempts === 1) throw new Error("db down"); } } });
    const d = delivery(orderPayload(), { topic: "orders/create", webhookId: "retry-me" });
    const first = await send(d);
    expect(first).toMatchObject({ status: 500, body: { error: "handler_failed" }, reason: "handler_threw" });
    expect(first.error).toContain("db down");
    expect((await send(d)).body).toMatchObject({ status: "processed" });
    expect(attempts).toBe(2);
  });

  it("answers 400 for a PayloadError (no point in Shopify retrying) and 500 for any other error", async () => {
    const { send } = setup({ handlers: { "orders/create": () => { throw new PayloadError("bad shape"); }, "orders/updated": () => { throw new TypeError("bug"); } } });
    expect(await send(delivery(orderPayload(), { topic: "orders/create" }))).toMatchObject({ status: 400, body: { error: "invalid_payload" } });
    expect(await send(delivery(orderPayload(), { topic: "orders/updated" }))).toMatchObject({ status: 500 });
  });

  it("answers 500 store_unavailable when claiming fails, without running the handler", async () => {
    const broken: DedupeStore = { claim: async () => { throw new Error("disk full"); }, complete: async () => {}, fail: async () => {} };
    const { calls, send } = setup({}, broken);
    expect(await send(delivery(orderPayload(), { topic: "orders/create" }))).toMatchObject({ status: 500, reason: "store_claim_failed" });
    expect(calls).toHaveLength(0);
  });

  it("answers 500 when the work finished but could not be marked done; the next delivery waits out the lock, then re-runs the (idempotent) handler", async () => {
    const clock = { t: 0 };
    const memory = createMemoryStore({ now: () => clock.t, lockTimeoutMs: 1000 });
    let failComplete = true;
    const store: DedupeStore = { ...memory, complete: async (key) => { if (failComplete) throw new Error("lost connection"); await memory.complete(key); } };
    const { calls, send } = setup({}, store);
    const d = delivery(orderPayload(), { topic: "orders/create", webhookId: "w" });
    expect(await send(d)).toMatchObject({ status: 500, reason: "store_complete_failed" });
    expect((await send(d)).status).toBe(409); // still marked in flight
    clock.t += 1001;
    failComplete = false;
    expect((await send(d)).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("a handler failure reaches Shopify as non-2xx, so its documented retry (8 over 4 hours) applies", async () => {
    const { send } = setup({ handlers: { "orders/create": () => { throw new Error("x"); } } });
    const r = await send(delivery(orderPayload(), { topic: "orders/create" }));
    expect(r.status < 200 || r.status >= 300).toBe(true);
  });
});

describe("compliance webhooks", () => {
  // these tests use the real order handlers, so erasure can be checked against rows that were really stored
  const setup = (over: Partial<WebhookOptions> = {}, store?: DedupeStore) => setupWith(over, store, false);
  const row = (db: Db, webhookId: string) => db.prepare("SELECT * FROM compliance_requests WHERE webhook_id = ?").get(webhookId) as Record<string, unknown> | undefined;

  it("answers a bad HMAC on every compliance topic with 401 and records nothing", async () => {
    const { db, send } = setup();
    for (const [topic, payload] of [["customers/data_request", dataRequestPayload()], ["customers/redact", customerRedactPayload()], ["shop/redact", shopRedactPayload()]] as const) {
      expect((await send(delivery(payload, { topic, secret: "forged" }))).status).toBe(401);
    }
    expect(count(db, "compliance_requests")).toBe(0);
  });

  it("records customers/data_request with a 30-day deadline and keeps it open for a person to fulfil", async () => {
    const { db, send } = setup();
    const r = await send(delivery(dataRequestPayload(), { topic: "customers/data_request", webhookId: "dr-1" }));
    expect(r.status).toBe(200);
    const stored = row(db, "dr-1")!;
    expect(stored).toMatchObject({ topic: "customers/data_request", shop_domain: SHOP_DOMAIN, shop_id: "548380009", customer_id: "7000000001", status: "received", received_at: 1_800_000_000_000 });
    expect(stored["due_at"]).toBe(1_800_000_000_000 + COMPLIANCE_DUE_MS);
    expect(COMPLIANCE_DUE_MS).toBe(30 * 24 * 3600 * 1000);
  });

  it("prepares the data export for the orders it holds and does not modify them", async () => {
    const { db, send } = setup();
    await send(delivery(orderPayload(), { topic: "orders/create" }));
    await send(delivery(dataRequestPayload(), { topic: "customers/data_request", webhookId: "dr-2" }));
    const result = JSON.parse(row(db, "dr-2")!["result"] as string) as { orders: Array<{ order_id: string; email: string }> };
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({ order_id: "5000001001", email: "ada@example.invalid" });
    expect((db.prepare("SELECT email FROM orders_seen WHERE order_id = '5000001001'").get() as { email: string }).email).toBe("ada@example.invalid");
  });

  it("customers/redact erases stored personal data, completes, and scrubs the personal data out of its own record", async () => {
    const { db, send } = setup();
    await send(delivery(orderPayload(), { topic: "orders/create" }));
    const r = await send(delivery(customerRedactPayload(), { topic: "customers/redact", webhookId: "cr-1" }));
    expect(r.status).toBe(200);
    const order = db.prepare("SELECT email, customer_id, redacted FROM orders_seen WHERE order_id = '5000001001'").get() as Record<string, unknown>;
    expect(order).toEqual({ email: null, customer_id: null, redacted: 1 });
    const stored = row(db, "cr-1")!;
    expect(stored["status"]).toBe("completed");
    expect(stored["customer_email"]).toBeNull();
    expect(String(stored["payload"])).not.toContain("ada@example.invalid");
    expect(String(stored["payload"])).not.toContain("+15555550100");
  });

  it("customers/redact also catches the customer's other orders by customer id, and leaves other customers alone", async () => {
    const { db, send } = setup();
    await send(delivery(orderPayload({ id: 5000001002 }), { topic: "orders/create" }));
    await send(delivery(orderPayload({ id: 5000001003, customer: { id: 7000000002 }, email: "grace@example.invalid" }), { topic: "orders/create" }));
    await send(delivery(customerRedactPayload({ orders_to_redact: [] }), { topic: "customers/redact" }));
    const rows = db.prepare("SELECT order_id, email, redacted FROM orders_seen ORDER BY order_id").all() as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { order_id: "5000001002", email: null, redacted: 1 },
      { order_id: "5000001003", email: "grace@example.invalid", redacted: 0 },
    ]);
  });

  it("redaction arriving before the order leaves a tombstone, so a late orders/create cannot store the email", async () => {
    const { db, send } = setup();
    await send(delivery(customerRedactPayload(), { topic: "customers/redact" }));
    await send(delivery(orderPayload(), { topic: "orders/create" }));
    const order = db.prepare("SELECT email, customer_id, name, redacted FROM orders_seen WHERE order_id = '5000001001'").get() as Record<string, unknown>;
    expect(order).toEqual({ email: null, customer_id: null, name: "#1001", redacted: 1 });
  });

  it("shop/redact deletes that shop's orders, refunds and token and leaves another shop's data", async () => {
    const { db, send } = setup();
    const other = "second-demo.myshopify.com";
    db.prepare("INSERT INTO shops (shop_domain, access_token, scope, installed_at) VALUES (?, 't', 'read_orders', 1)").run(SHOP_DOMAIN);
    db.prepare("INSERT INTO shops (shop_domain, access_token, scope, installed_at) VALUES (?, 't', 'read_orders', 1)").run(other);
    await send(delivery(orderPayload(), { topic: "orders/create" }));
    await send(delivery(refundPayload(), { topic: "refunds/create" }));
    await send(delivery(orderPayload({ id: 1 }), { topic: "orders/create", shop: other }));
    expect((await send(delivery(shopRedactPayload(), { topic: "shop/redact", webhookId: "sr-1" }))).status).toBe(200);
    expect(count(db, "shops")).toBe(1);
    expect(db.prepare("SELECT shop_domain FROM orders_seen").all()).toEqual([{ shop_domain: other }]);
    expect(count(db, "refunds_seen")).toBe(0);
    expect(row(db, "sr-1")!["status"]).toBe("completed");
  });

  it("records a re-delivery once: same webhook id -> one row, second answer is a duplicate 200", async () => {
    const { db, send } = setup();
    const d = delivery(shopRedactPayload(), { topic: "shop/redact", webhookId: "once" });
    await send(d);
    expect((await send(d)).body).toMatchObject({ status: "duplicate" });
    expect(count(db, "compliance_requests")).toBe(1);
  });

  it("records a different delivery of the same request as its own row", async () => {
    const { db, send } = setup();
    await send(delivery(shopRedactPayload(), { topic: "shop/redact", webhookId: "one" }));
    await send(delivery(shopRedactPayload(), { topic: "shop/redact", webhookId: "two" }));
    expect(count(db, "compliance_requests")).toBe(2);
  });

  it("answers 400 and records nothing for a compliance payload missing required fields", async () => {
    const { db, send } = setup();
    expect(await send(delivery(customerRedactPayload({ customer: undefined }), { topic: "customers/redact" }))).toMatchObject({ status: 400, body: { error: "invalid_payload" } });
    expect(await send(delivery({ shop_domain: SHOP_DOMAIN }, { topic: "shop/redact" }))).toMatchObject({ status: 400 });
    expect(await send(delivery(shopRedactPayload({ shop_domain: "evil.example" }), { topic: "shop/redact" }))).toMatchObject({ status: 400 });
    expect(await send(delivery(dataRequestPayload({ orders_requested: ["abc"] }), { topic: "customers/data_request" }))).toMatchObject({ status: 400 });
    expect(count(db, "compliance_requests")).toBe(0);
  });

  it("accepts a customer that has only an email (the docs say that happens)", async () => {
    const { db, send } = setup();
    const r = await send(delivery(customerRedactPayload({ customer: { email: "only@example.invalid" }, orders_to_redact: [] }), { topic: "customers/redact", webhookId: "email-only" }));
    expect(r.status).toBe(200);
    expect(row(db, "email-only")).toBeDefined();
  });

  it("keeps ids above 2^53 exact (JSON.parse would round them)", async () => {
    const { db, send } = setup();
    const raw = `{"shop_id":820982911946154508,"shop_domain":"${SHOP_DOMAIN}","customer":{"id":820982911946154510,"email":"x@example.invalid"},"orders_to_redact":[820982911946154511]}`;
    expect(Number("820982911946154508")).not.toBe(820982911946154508n as unknown as number); // the plain-number route is lossy
    const r = await send(delivery(null, { topic: "customers/redact", rawBody: raw, webhookId: "big" }));
    expect(r.status).toBe(200);
    const stored = row(db, "big")!;
    expect(stored["shop_id"]).toBe("820982911946154508");
    expect(stored["customer_id"]).toBe("820982911946154510");
    expect((db.prepare("SELECT order_id, redacted FROM orders_seen").get() as Record<string, unknown>)).toEqual({ order_id: "820982911946154511", redacted: 1 });
  });

  it("when the sink throws, answers 500 and a retry completes it", async () => {
    const inner = createSqliteCompliance(openDb());
    let first = true;
    const { send } = setup({ compliance: { record: (e) => inner.record(e), execute: (e) => { if (first) { first = false; throw new Error("disk"); } inner.execute(e); } } });
    const d = delivery(shopRedactPayload(), { topic: "shop/redact", webhookId: "flaky" });
    expect((await send(d)).status).toBe(500);
    expect((await send(d)).status).toBe(200);
  });
});

describe("order topics through the receiver", () => {
  it("stores the order from orders/create and applies a later orders/updated", async () => {
    const { db, send } = setup({}, undefined, false);
    await send(delivery(orderPayload(), { topic: "orders/create" }));
    await send(delivery(orderPayload({ updated_at: "2026-10-30T15:00:00Z", financial_status: "refunded" }), { topic: "orders/updated" }));
    expect(db.prepare("SELECT financial_status FROM orders_seen").get()).toEqual({ financial_status: "refunded" });
  });

  it("answers 400 for an order payload without an id, so Shopify does not retry it for hours", async () => {
    const { send } = setup({}, undefined, false);
    expect(await send(delivery({ name: "#1" }, { topic: "orders/create" }))).toMatchObject({ status: 400, body: { error: "invalid_payload" } });
  });

  it("stores an order whose id is above 2^53 under its exact digits", async () => {
    const { db, send } = setup({}, undefined, false);
    const raw = '{"id":820982911946154508,"name":"#9","updated_at":"2026-10-30T14:00:05Z"}';
    expect((await send(delivery(null, { topic: "orders/create", rawBody: raw }))).status).toBe(200);
    expect(db.prepare("SELECT order_id FROM orders_seen").get()).toEqual({ order_id: "820982911946154508" });
  });
});

describe("parseJsonKeepingBigIds", () => {
  it("keeps large integer literals as exact strings and leaves everything else alone", () => {
    expect(parseJsonKeepingBigIds('{"id":820982911946154508,"n":5,"f":1.5,"neg":-820982911946154508,"s":"x","a":[1,2]}')).toEqual({ id: "820982911946154508", n: 5, f: 1.5, neg: "-820982911946154508", s: "x", a: [1, 2] });
  });
  it("does not stringify exponent notation or floats", () => {
    expect(parseJsonKeepingBigIds('{"x":1e30,"y":123456789012345680000.5}')).toEqual({ x: 1e30, y: 123456789012345680000.5 });
  });
});
