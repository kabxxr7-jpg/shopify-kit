// Shopify webhook receiver (HTTPS delivery), framework-agnostic.
//
// Order of work, and why:
//   1. refuse a body that is not raw bytes/text (an already-parsed body cannot be verified)
//   2. verify X-Shopify-Hmac-SHA256 = base64(HMAC-SHA256(raw body, client secret)), constant-time -> else 401
//      (the compliance docs require 401 for an invalid HMAC; the docs' sample does the same for all topics)
//   3. read the delivery headers (topic, shop domain, webhook id, event id, API version)
//   4. parse the JSON body
//   5. de-duplicate on X-Shopify-Webhook-Id ("a unique composite key per delivery") -> duplicates get 200
//   6. route by topic: the three compliance topics are validated, recorded and executed; other topics go to
//      your handlers; a topic nobody handles is acknowledged with 200 so Shopify does not retry it
//   7. answer 200 only after the handler finished; a throw releases the claim and answers 500, so Shopify's
//      retries (8 over 4 hours) re-run it. Anything outside 2xx counts as a failure to Shopify, including 3xx;
//      the whole request must finish within 5 seconds, so queue slow work instead of doing it here.
import { isComplianceTopic, parseCompliancePayload, type ComplianceSink } from "./compliance.ts";
import type { DedupeStore } from "./dedupe.ts";
import { verifyWebhookHmac } from "./hmac.ts";
import { isValidShopDomain } from "./shop.ts";

export interface WebhookContext {
  topic: string;
  shopDomain: string;
  webhookId: string;
  eventId: string | null;
  apiVersion: string | null;
  triggeredAt: string | null;
  payload: unknown;
  rawBody: string;
}
export type WebhookHandler = (context: WebhookContext) => void | Promise<void>;

/** Throw from a handler for a payload that can never be processed; answered 400 instead of 500. */
export class PayloadError extends Error {
  override name = "PayloadError";
}

export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface WebhookOptions {
  /** App client secret (or [new, old] while a rotation propagates). */
  secrets: string | readonly string[];
  store: DedupeStore;
  /** Where the three compliance topics are recorded and executed. Required: they must never be dropped. */
  compliance: ComplianceSink;
  /** topic -> handler, for example "orders/create". */
  handlers?: Readonly<Record<string, WebhookHandler>>;
  /**
   * "webhook-id" (default, as documented): one execution per delivery.
   * "event-id-and-topic": also collapses the separate deliveries Shopify makes when an app has several
   * subscriptions to one topic (same X-Shopify-Event-Id, different webhook ids). Not the documented default.
   */
  dedupeBy?: "webhook-id" | "event-id-and-topic";
  now?: () => number;
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
  /** Machine-readable cause for logs; never put it in a response to a stranger. */
  reason?: string;
  error?: string;
}

export function getHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined; // a repeated header is ambiguous
    return value;
  }
  return undefined;
}

/**
 * JSON.parse that does not corrupt large integers. Shopify's own sample payloads use ids such as
 * 820982911946154508, which is above Number.MAX_SAFE_INTEGER (9007199254740991): a plain JSON.parse would round it
 * and a refund could then be matched to the wrong order. Integer literals that do not fit are returned as the
 * exact digit string (read from the source text); everything else parses normally.
 */
export function parseJsonKeepingBigIds(text: string): unknown {
  return JSON.parse(text, function (_key: string, value: unknown, context?: { source?: string }) {
    if (typeof value === "number" && !Number.isSafeInteger(value) && Number.isInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source)) {
      return context.source;
    }
    return value;
  } as Parameters<typeof JSON.parse>[1]);
}

const reject = (status: number, error: string, reason?: string): WebhookResult => ({ status, body: { error }, ...(reason ? { reason } : {}) });

export async function handleShopifyWebhook(input: { rawBody: unknown; headers: HeadersLike }, options: WebhookOptions): Promise<WebhookResult> {
  const { rawBody, headers } = input;
  if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) {
    return reject(400, "body_not_raw", "rawBody must be the exact bytes received; an already-parsed body (express.json()) cannot be verified");
  }

  const hmacHeader = getHeader(headers, "x-shopify-hmac-sha256");
  if (!hmacHeader) return reject(401, "invalid_hmac", "missing_hmac");
  if (!verifyWebhookHmac({ secrets: options.secrets, rawBody, header: hmacHeader })) return reject(401, "invalid_hmac", "hmac_mismatch");

  const topic = getHeader(headers, "x-shopify-topic");
  const shopDomain = getHeader(headers, "x-shopify-shop-domain");
  const webhookId = getHeader(headers, "x-shopify-webhook-id");
  const eventId = getHeader(headers, "x-shopify-event-id") ?? null;
  if (!topic) return reject(400, "missing_topic", "missing_topic");
  if (!isValidShopDomain(shopDomain)) return reject(400, "invalid_shop_domain", "invalid_shop_domain");
  if (!webhookId) return reject(400, "missing_webhook_id", "missing_webhook_id");

  let text: string;
  try {
    text = typeof rawBody === "string" ? rawBody : new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return reject(400, "invalid_body", "body_not_utf8");
  }
  let payload: unknown;
  try {
    payload = parseJsonKeepingBigIds(text);
  } catch {
    return reject(400, "invalid_json", "invalid_json");
  }

  const context: WebhookContext = {
    topic,
    shopDomain: shopDomain.toLowerCase(),
    webhookId,
    eventId,
    apiVersion: getHeader(headers, "x-shopify-api-version") ?? null,
    triggeredAt: getHeader(headers, "x-shopify-triggered-at") ?? null,
    payload,
    rawBody: text,
  };

  const handler = options.handlers?.[topic];
  if (!isComplianceTopic(topic) && !handler) return { status: 200, body: { received: true, status: "ignored" }, reason: "no_handler_for_topic" };

  let key = webhookId;
  if (options.dedupeBy === "event-id-and-topic") {
    if (!eventId) return reject(400, "missing_event_id", "missing_event_id");
    key = `${eventId}:${topic}`;
  }

  let claim: Awaited<ReturnType<DedupeStore["claim"]>>;
  try {
    claim = await options.store.claim(key, { topic, shopDomain: context.shopDomain });
  } catch (error) {
    return { status: 500, body: { error: "store_unavailable" }, reason: "store_claim_failed", error: String(error) };
  }
  if (claim === "done") return { status: 200, body: { received: true, status: "duplicate" } };
  if (claim === "in_flight") return { status: 409, body: { received: false, status: "in_flight" }, reason: "same_delivery_in_progress" };

  try {
    if (isComplianceTopic(topic)) {
      const parsed = parseCompliancePayload(topic, payload);
      if (!parsed.ok) throw new PayloadError(`invalid ${topic} payload: ${parsed.reason}`);
      const entry = { webhookId, eventId, request: parsed.request, rawBody: text, receivedAt: (options.now ?? Date.now)() };
      options.compliance.record(entry);
      options.compliance.execute(entry);
    } else if (handler) {
      await handler(context);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    try {
      await options.store.fail(key, text);
    } catch {
      /* the original failure is the one to report */
    }
    if (error instanceof PayloadError) return { status: 400, body: { error: "invalid_payload" }, reason: "invalid_payload", error: text };
    return { status: 500, body: { error: "handler_failed" }, reason: "handler_threw", error: text };
  }

  try {
    await options.store.complete(key);
  } catch (error) {
    // The work is done but could not be marked; a retry will run the (idempotent) handler again.
    return { status: 500, body: { error: "store_unavailable" }, reason: "store_complete_failed", error: String(error) };
  }
  return { status: 200, body: { received: true, status: "processed" } };
}
