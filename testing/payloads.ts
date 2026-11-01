// Webhook payloads in the REST-shaped JSON the Webhooks reference shows for each topic (shapes only; every value is fictional).
export const SHOP_DOMAIN = "harbour-pine-demo.myshopify.com";
export const SHOP_ID = 548380009;

export function orderPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5000001001,
    name: "#1001",
    created_at: "2026-10-30T14:00:00Z",
    processed_at: "2026-10-30T14:00:00Z",
    updated_at: "2026-10-30T14:00:05Z",
    cancelled_at: null,
    financial_status: "paid",
    test: false,
    currency: "CAD",
    total_price: "63.85",
    email: "ada@example.invalid",
    customer: { id: 7000000001, email: "ada@example.invalid" },
    ...over,
  };
}

export function refundPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 9000010031, order_id: 5000001001, processed_at: "2026-11-02T04:30:00Z", ...over };
}

export function dataRequestPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shop_id: SHOP_ID,
    shop_domain: SHOP_DOMAIN,
    orders_requested: [5000001001, 5000001003],
    customer: { id: 7000000001, email: "ada@example.invalid", phone: "+15555550100" },
    data_request: { id: 9999 },
    ...over,
  };
}

export function customerRedactPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shop_id: SHOP_ID,
    shop_domain: SHOP_DOMAIN,
    customer: { id: 7000000001, email: "ada@example.invalid", phone: "+15555550100" },
    orders_to_redact: [5000001001, 5000001003],
    ...over,
  };
}

export function shopRedactPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { shop_id: SHOP_ID, shop_domain: SHOP_DOMAIN, ...over };
}
