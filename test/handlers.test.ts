import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.ts";
import { applyOrderEvent, applyRefundEvent, createOrderHandlers } from "../src/handlers.ts";
import { PayloadError, type WebhookContext } from "../src/webhooks.ts";
import { SHOP_DOMAIN, orderPayload, refundPayload } from "../testing/payloads.ts";

const ctx = (payload: unknown, topic = "orders/updated", shopDomain = SHOP_DOMAIN): WebhookContext => ({
  topic,
  shopDomain,
  webhookId: `w-${Math.random()}`,
  eventId: null,
  apiVersion: "2026-10",
  triggeredAt: null,
  payload,
  rawBody: JSON.stringify(payload),
});

const order = (db: Db, id = "5000001001") => db.prepare("SELECT * FROM orders_seen WHERE shop_domain = ? AND order_id = ?").get(SHOP_DOMAIN, id) as Record<string, unknown> | undefined;

// four events in the life of one order, each with its own updated_at
const events = {
  create: ctx(orderPayload({ name: "#1001", updated_at: "2026-10-30T14:00:00Z", financial_status: "pending", total_price: "63.85" }), "orders/create"),
  paid: ctx(orderPayload({ name: "#1001", updated_at: "2026-10-30T14:01:00Z", financial_status: "paid", total_price: "63.85" }), "orders/paid"),
  edited: ctx(orderPayload({ name: "#1001-A", updated_at: "2026-10-30T14:02:00Z", financial_status: "paid", total_price: "70.00" }), "orders/updated"),
  cancelled: ctx(orderPayload({ name: "#1001-A", updated_at: "2026-10-30T14:03:00Z", financial_status: "voided", cancelled_at: "2026-10-30T14:03:00Z", total_price: "70.00" }), "orders/cancelled"),
};

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe("order events", () => {
  it("inserts on first sight", () => {
    const db = openDb();
    applyOrderEvent(db, events.create);
    expect(order(db)).toMatchObject({ name: "#1001", financial_status: "pending", currency: "CAD", total_price: "63.85", redacted: 0, test: 0, last_topic: "orders/create" });
  });

  it("applies a newer event and ignores an older one", () => {
    const db = openDb();
    applyOrderEvent(db, events.paid);
    applyOrderEvent(db, events.create); // older, arrives late
    expect(order(db)).toMatchObject({ financial_status: "paid", last_topic: "orders/paid" });
    applyOrderEvent(db, events.edited);
    expect(order(db)).toMatchObject({ name: "#1001-A", total_price: "70.00" });
  });

  it("re-applying the same event changes nothing (idempotent)", () => {
    const db = openDb();
    applyOrderEvent(db, events.edited);
    const once = order(db);
    applyOrderEvent(db, events.edited);
    applyOrderEvent(db, events.edited);
    expect(order(db)).toEqual(once);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders_seen").get()).toEqual({ n: 1 });
  });

  it("converges to the same final row for every one of the 24 delivery orders of the four events", () => {
    const inOrder = openDb();
    for (const e of [events.create, events.paid, events.edited, events.cancelled]) applyOrderEvent(inOrder, e);
    const expected = order(inOrder)!;
    expect(expected).toMatchObject({ name: "#1001-A", financial_status: "voided", cancelled_at: "2026-10-30T14:03:00Z", total_price: "70.00" });
    const orderings = permutations([events.create, events.paid, events.edited, events.cancelled]);
    expect(orderings).toHaveLength(24);
    for (const sequence of orderings) {
      const db = openDb();
      for (const e of sequence) applyOrderEvent(db, e);
      // last_topic / last_event_id are bookkeeping about the newest applied event, which is the same event in every ordering
      expect(order(db), sequence.map((e) => e.topic).join(" > ")).toEqual(expected);
    }
  });

  it("keeps an order cancelled once any event said so, even if a newer event has cancelled_at null", () => {
    const db = openDb();
    applyOrderEvent(db, events.cancelled);
    applyOrderEvent(db, ctx(orderPayload({ updated_at: "2026-10-30T16:00:00Z", cancelled_at: null, financial_status: "paid" })));
    expect(order(db)).toMatchObject({ cancelled_at: "2026-10-30T14:03:00Z", financial_status: "paid" });
  });

  it("learns a cancellation from a stale event without regressing the other fields", () => {
    const db = openDb();
    applyOrderEvent(db, events.edited);
    applyOrderEvent(db, ctx(orderPayload({ updated_at: "2026-10-30T14:00:30Z", cancelled_at: "2026-10-30T14:00:30Z", financial_status: "voided" })));
    expect(order(db)).toMatchObject({ cancelled_at: "2026-10-30T14:00:30Z", financial_status: "paid", name: "#1001-A" });
  });

  it("keeps shops apart even for the same order id", () => {
    const db = openDb();
    applyOrderEvent(db, events.create);
    applyOrderEvent(db, ctx(orderPayload({ name: "#other" }), "orders/create", "second-demo.myshopify.com"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders_seen").get()).toEqual({ n: 2 });
    expect(order(db)).toMatchObject({ name: "#1001" });
  });

  it("records test orders as test", () => {
    const db = openDb();
    applyOrderEvent(db, ctx(orderPayload({ test: true })));
    expect(order(db)).toMatchObject({ test: 1 });
  });

  it("never lets a late event put personal data back on a redacted order", () => {
    const db = openDb();
    db.prepare("INSERT INTO orders_seen (shop_domain, order_id, updated_at_ms, redacted) VALUES (?, '5000001001', 0, 1)").run(SHOP_DOMAIN);
    applyOrderEvent(db, events.paid);
    expect(order(db)).toMatchObject({ redacted: 1, email: null, customer_id: null, financial_status: "paid" });
  });

  it.each([
    ["not an object", "text"],
    ["null", null],
    ["no id", { updated_at: "2026-10-30T14:00:00Z" }],
    ["no updated_at", { id: 1 }],
    ["unparseable updated_at", { id: 1, updated_at: "yesterday" }],
    ["non-digit id", { id: "abc", updated_at: "2026-10-30T14:00:00Z" }],
  ])("throws PayloadError for %s", (_name, payload) => {
    expect(() => applyOrderEvent(openDb(), ctx(payload))).toThrow(PayloadError);
  });
});

describe("refund events", () => {
  it("stores a refund even before its order exists", () => {
    const db = openDb();
    applyRefundEvent(db, ctx(refundPayload(), "refunds/create"));
    expect(db.prepare("SELECT refund_id, order_id, processed_at FROM refunds_seen").all()).toEqual([{ refund_id: "9000010031", order_id: "5000001001", processed_at: "2026-11-02T04:30:00Z" }]);
    expect(order(db)).toBeUndefined();
  });

  it("is idempotent per refund id and takes the latest delivery's values", () => {
    const db = openDb();
    applyRefundEvent(db, ctx(refundPayload(), "refunds/create"));
    applyRefundEvent(db, ctx(refundPayload({ processed_at: "2026-11-02T05:00:00Z" }), "refunds/create"));
    expect(db.prepare("SELECT COUNT(*) AS n FROM refunds_seen").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT processed_at FROM refunds_seen").get()).toEqual({ processed_at: "2026-11-02T05:00:00Z" });
  });

  it("rejects a payload without id and order_id", () => {
    expect(() => applyRefundEvent(openDb(), ctx({ id: 1 }, "refunds/create"))).toThrow(PayloadError);
    expect(() => applyRefundEvent(openDb(), ctx(7, "refunds/create"))).toThrow(PayloadError);
  });
});

describe("createOrderHandlers", () => {
  it("covers the order topics, refunds and uninstall, and nothing else", () => {
    expect(Object.keys(createOrderHandlers(openDb())).sort()).toEqual(["app/uninstalled", "orders/cancelled", "orders/create", "orders/paid", "orders/updated", "refunds/create"]);
  });

  it("app/uninstalled drops that shop's access token only", async () => {
    const db = openDb();
    for (const shop of [SHOP_DOMAIN, "second-demo.myshopify.com"]) db.prepare("INSERT INTO shops (shop_domain, access_token, scope, installed_at) VALUES (?, 't', 'read_orders', 1)").run(shop);
    await createOrderHandlers(db)["app/uninstalled"]!(ctx({}, "app/uninstalled"));
    expect(db.prepare("SELECT shop_domain FROM shops").all()).toEqual([{ shop_domain: "second-demo.myshopify.com" }]);
  });
});
