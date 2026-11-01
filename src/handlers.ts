// Handlers for the order topics, safe against out-of-order and repeated delivery. Shopify does not promise
// delivery order (retries over 4 hours mean an old event can arrive after a newer one), so each handler is an
// idempotent upsert that never lets an older fact undo a newer one:
//
//   * scalars (name, financial status, ...) are overwritten only by an event whose updated_at is not older than
//     the newest one already applied; equal timestamps re-apply the same data
//   * cancelled_at is sticky: once an event says the order is cancelled, no later or earlier event clears it
//     (this is this kit's rule; the docs read do not say whether a cancellation can be undone)
//   * an order whose customer data was redacted keeps email and customer id NULL, even if an old event with the
//     email arrives afterwards
//   * a refund can arrive before its order; refunds are keyed by their own id and carry no foreign key
//
// Payload field names are those of the sample payloads on the Webhooks reference page (REST-shaped JSON).
import { transaction, type Db } from "./db.ts";
import { PayloadError, type WebhookContext, type WebhookHandler } from "./webhooks.ts";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const idString = (v: unknown): string | null => (typeof v === "number" && Number.isSafeInteger(v) ? String(v) : typeof v === "string" && /^\d+$/.test(v) ? v : null);

interface OrderRow {
  updated_at_ms: number;
  cancelled_at: string | null;
  redacted: number;
}

export function applyOrderEvent(db: Db, ctx: WebhookContext): void {
  const p = ctx.payload as Record<string, unknown> | null;
  if (typeof p !== "object" || p === null) throw new PayloadError("order payload is not an object");
  const orderId = idString(p["id"]);
  if (!orderId) throw new PayloadError("order payload has no id");
  const updatedAt = str(p["updated_at"]);
  const ms = updatedAt === null ? NaN : Date.parse(updatedAt);
  if (!Number.isFinite(ms)) throw new PayloadError("order payload has no valid updated_at");
  const customer = typeof p["customer"] === "object" && p["customer"] !== null ? (p["customer"] as Record<string, unknown>) : null;
  const incoming = {
    name: str(p["name"]),
    created_at: str(p["created_at"]),
    processed_at: str(p["processed_at"]),
    cancelled_at: str(p["cancelled_at"]),
    financial_status: str(p["financial_status"]),
    test: p["test"] === true ? 1 : 0,
    currency: str(p["currency"]),
    total_price: str(p["total_price"]),
    customer_id: customer ? idString(customer["id"]) : null,
    email: str(p["email"]),
  };

  transaction(db, () => {
    const existing = db.prepare("SELECT updated_at_ms, cancelled_at, redacted FROM orders_seen WHERE shop_domain = ? AND order_id = ?").get(ctx.shopDomain, orderId) as OrderRow | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO orders_seen (shop_domain, order_id, name, updated_at_ms, created_at, processed_at, cancelled_at, financial_status, test, currency, total_price, customer_id, email, last_topic, last_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(ctx.shopDomain, orderId, incoming.name, ms, incoming.created_at, incoming.processed_at, incoming.cancelled_at, incoming.financial_status, incoming.test, incoming.currency, incoming.total_price, incoming.customer_id, incoming.email, ctx.topic, ctx.eventId);
      return;
    }
    const cancelledAt = existing.cancelled_at ?? incoming.cancelled_at;
    if (ms < existing.updated_at_ms) {
      // stale event: only a cancellation (a fact that cannot be undone) may be learned from it
      if (cancelledAt !== existing.cancelled_at) db.prepare("UPDATE orders_seen SET cancelled_at = ? WHERE shop_domain = ? AND order_id = ?").run(cancelledAt, ctx.shopDomain, orderId);
      return;
    }
    const keepPiiOut = existing.redacted === 1;
    db.prepare(
      `UPDATE orders_seen SET name = ?, updated_at_ms = ?, created_at = ?, processed_at = ?, cancelled_at = ?, financial_status = ?, test = ?, currency = ?, total_price = ?,
         customer_id = ?, email = ?, last_topic = ?, last_event_id = ? WHERE shop_domain = ? AND order_id = ?`,
    ).run(incoming.name, ms, incoming.created_at, incoming.processed_at, cancelledAt, incoming.financial_status, incoming.test, incoming.currency, incoming.total_price, keepPiiOut ? null : incoming.customer_id, keepPiiOut ? null : incoming.email, ctx.topic, ctx.eventId, ctx.shopDomain, orderId);
  });
}

export function applyRefundEvent(db: Db, ctx: WebhookContext): void {
  const p = ctx.payload as Record<string, unknown> | null;
  if (typeof p !== "object" || p === null) throw new PayloadError("refund payload is not an object");
  const refundId = idString(p["id"]);
  const orderId = idString(p["order_id"]);
  if (!refundId || !orderId) throw new PayloadError("refund payload needs id and order_id");
  db.prepare(
    `INSERT INTO refunds_seen (shop_domain, refund_id, order_id, processed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_domain, refund_id) DO UPDATE SET order_id = excluded.order_id, processed_at = excluded.processed_at`,
  ).run(ctx.shopDomain, refundId, orderId, str(p["processed_at"]));
}

export function createOrderHandlers(db: Db): Record<string, WebhookHandler> {
  const order: WebhookHandler = (ctx) => applyOrderEvent(db, ctx);
  return {
    "orders/create": order,
    "orders/updated": order,
    "orders/paid": order,
    "orders/cancelled": order,
    "refunds/create": (ctx) => applyRefundEvent(db, ctx),
    // The token is useless after uninstall; shop/redact follows 48 hours later for the rest of the data.
    "app/uninstalled": (ctx) => {
      db.prepare("DELETE FROM shops WHERE shop_domain = ?").run(ctx.shopDomain);
    },
  };
}
