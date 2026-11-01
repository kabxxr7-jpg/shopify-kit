// The three mandatory compliance webhooks (docs: "Privacy law compliance"). Every app distributed through the
// Shopify App Store must subscribe to them and answer them whether or not it stores personal data:
//
//   customers/data_request  a customer asked the store owner for their data. Your app provides the data to the
//                           store owner directly. Payload: shop_id, shop_domain, orders_requested[], customer
//                           {id,email,phone}, data_request {id}
//   customers/redact        the store owner asked for deletion; sent 10 days after the request. Payload: shop_id,
//                           shop_domain, customer {id,email,phone}, orders_to_redact[]
//   shop/redact             sent 48 hours after the app is uninstalled. Payload: shop_id, shop_domain
//
// Requirements: POST with a JSON body; an invalid HMAC must be answered 401; confirm receipt with a 2xx; complete
// the action within 30 days (unless legally required to retain data). The receiver records every delivery in
// `compliance_requests` (one row per X-Shopify-Webhook-Id) and then runs the erasure for the data THIS kit stores.
import { transaction, type Db } from "./db.ts";
import { isValidShopDomain } from "./shop.ts";

export const COMPLIANCE_TOPICS = ["customers/data_request", "customers/redact", "shop/redact"] as const;
export type ComplianceTopic = (typeof COMPLIANCE_TOPICS)[number];
export const COMPLIANCE_DUE_MS = 30 * 24 * 60 * 60 * 1000;

export function isComplianceTopic(topic: string): topic is ComplianceTopic {
  return (COMPLIANCE_TOPICS as readonly string[]).includes(topic);
}

type Id = number | string;
export interface ComplianceRequest {
  topic: ComplianceTopic;
  shopId: Id;
  shopDomain: string;
  customer?: { id?: Id; email?: string | null; phone?: string | null };
  ordersRequested: Id[];
  ordersToRedact: Id[];
  dataRequestId?: Id;
}
export type ParsedCompliance = { ok: true; request: ComplianceRequest } | { ok: false; reason: string };

const isId = (v: unknown): v is Id => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) || (typeof v === "string" && /^\d+$/.test(v));

function idList(value: unknown, name: string): Id[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(isId)) return `${name} must be an array of ids`;
  return value as Id[];
}

export function parseCompliancePayload(topic: ComplianceTopic, payload: unknown): ParsedCompliance {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { ok: false, reason: "payload is not a JSON object" };
  const p = payload as Record<string, unknown>;
  if (!isId(p["shop_id"])) return { ok: false, reason: "shop_id is missing or not an id" };
  if (!isValidShopDomain(p["shop_domain"])) return { ok: false, reason: "shop_domain is missing or not a myshopify.com domain" };
  const request: ComplianceRequest = { topic, shopId: p["shop_id"], shopDomain: p["shop_domain"].toLowerCase(), ordersRequested: [], ordersToRedact: [] };
  if (topic === "shop/redact") return { ok: true, request };

  const customer = p["customer"];
  if (typeof customer !== "object" || customer === null || Array.isArray(customer)) return { ok: false, reason: "customer object is missing" };
  const c = customer as Record<string, unknown>;
  const hasId = isId(c["id"]);
  const hasEmail = typeof c["email"] === "string" && c["email"].length > 0;
  // docs: "In some cases, a customer record contains only the customer's email address."
  if (!hasId && !hasEmail) return { ok: false, reason: "customer has neither id nor email" };
  request.customer = {
    ...(hasId ? { id: c["id"] as Id } : {}),
    ...(typeof c["email"] === "string" ? { email: c["email"] } : {}),
    ...(typeof c["phone"] === "string" ? { phone: c["phone"] } : {}),
  };
  if (topic === "customers/data_request") {
    const orders = idList(p["orders_requested"], "orders_requested");
    if (typeof orders === "string") return { ok: false, reason: orders };
    request.ordersRequested = orders;
    const dr = p["data_request"];
    if (typeof dr === "object" && dr !== null && isId((dr as Record<string, unknown>)["id"])) request.dataRequestId = (dr as Record<string, Id>)["id"] as Id;
  } else {
    const orders = idList(p["orders_to_redact"], "orders_to_redact");
    if (typeof orders === "string") return { ok: false, reason: orders };
    request.ordersToRedact = orders;
  }
  return { ok: true, request };
}

export interface ComplianceEntry {
  webhookId: string;
  eventId: string | null;
  request: ComplianceRequest;
  rawBody: string;
  receivedAt: number;
}

export interface ComplianceSink {
  /** Records the delivery. `inserted` is false when this webhook id was recorded before (a re-delivery). */
  record(entry: ComplianceEntry): { inserted: boolean };
  /** Runs the erasure / export for data this kit stores and updates the record. */
  execute(entry: ComplianceEntry): void;
}

export function createSqliteCompliance(db: Db): ComplianceSink {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO compliance_requests
       (webhook_id, event_id, topic, shop_domain, shop_id, customer_id, customer_email, payload, received_at, due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const finish = db.prepare("UPDATE compliance_requests SET status = ?, completed_at = ?, result = ? WHERE webhook_id = ?");
  const scrub = db.prepare("UPDATE compliance_requests SET customer_email = NULL, payload = ? WHERE webhook_id = ?");
  return {
    record(entry) {
      const r = entry.request;
      const { changes } = insert.run(
        entry.webhookId,
        entry.eventId,
        r.topic,
        r.shopDomain,
        String(r.shopId),
        r.customer?.id !== undefined ? String(r.customer.id) : null,
        r.customer?.email ?? null,
        entry.rawBody,
        entry.receivedAt,
        entry.receivedAt + COMPLIANCE_DUE_MS,
      );
      return { inserted: Number(changes) === 1 };
    },
    execute(entry) {
      const r = entry.request;
      transaction(db, () => {
        if (r.topic === "customers/data_request") {
          // Prepare an export of what this kit stores for the requested orders. Getting it to the store owner
          // is a manual step, so the request stays 'received' until a person marks it done.
          const rows = r.ordersRequested.map((id) => db.prepare("SELECT order_id, name, created_at, email, customer_id, total_price, currency FROM orders_seen WHERE shop_domain = ? AND order_id = ?").get(r.shopDomain, String(id))).filter(Boolean);
          finish.run("received", null, JSON.stringify({ exportPreparedFor: "store owner", orders: rows }), entry.webhookId);
        } else if (r.topic === "customers/redact") {
          let redacted = 0;
          for (const id of r.ordersToRedact) {
            // upsert: an order that has not been seen yet gets a tombstone so a later event cannot store its PII
            redacted += Number(
              db
                .prepare(
                  `INSERT INTO orders_seen (shop_domain, order_id, updated_at_ms, redacted) VALUES (?, ?, 0, 1)
                   ON CONFLICT(shop_domain, order_id) DO UPDATE SET email = NULL, customer_id = NULL, redacted = 1`,
                )
                .run(r.shopDomain, String(id)).changes,
            );
          }
          if (r.customer?.id !== undefined) {
            redacted += Number(db.prepare("UPDATE orders_seen SET email = NULL, customer_id = NULL, redacted = 1 WHERE shop_domain = ? AND customer_id = ? AND redacted = 0").run(r.shopDomain, String(r.customer.id)).changes);
          }
          // the request record itself must not keep the personal data it asked to delete
          const body = JSON.parse(entry.rawBody) as { customer?: Record<string, unknown> };
          if (body.customer) body.customer = { ...body.customer, email: null, phone: null };
          scrub.run(JSON.stringify(body), entry.webhookId);
          finish.run("completed", Date.now(), JSON.stringify({ orderRowsRedacted: redacted }), entry.webhookId);
        } else {
          const counts = {
            orders: Number(db.prepare("DELETE FROM orders_seen WHERE shop_domain = ?").run(r.shopDomain).changes),
            refunds: Number(db.prepare("DELETE FROM refunds_seen WHERE shop_domain = ?").run(r.shopDomain).changes),
            shops: Number(db.prepare("DELETE FROM shops WHERE shop_domain = ?").run(r.shopDomain).changes),
          };
          finish.run("completed", Date.now(), JSON.stringify({ deleted: counts }), entry.webhookId);
        }
      });
    },
  };
}
