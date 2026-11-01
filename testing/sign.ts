// Builds deliveries the way the docs describe them: JSON body, X-Shopify-* headers, base64 HMAC-SHA256 of the raw body.
import { computeWebhookHmac, computeOauthHmac } from "../src/hmac.ts";

export const TEST_SECRET = "test_client_secret_not_real_0123456789";

export interface DeliveryOptions {
  topic: string;
  shop?: string;
  webhookId?: string;
  eventId?: string;
  apiVersion?: string;
  secret?: string;
  /** Use these exact bytes instead of JSON.stringify(payload). */
  rawBody?: string;
}

let counter = 0;

export function delivery(payload: unknown, options: DeliveryOptions): { rawBody: string; headers: Record<string, string> } {
  const rawBody = options.rawBody ?? JSON.stringify(payload);
  counter++;
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": options.topic,
      "x-shopify-shop-domain": options.shop ?? "harbour-pine-demo.myshopify.com",
      "x-shopify-hmac-sha256": computeWebhookHmac(options.secret ?? TEST_SECRET, rawBody),
      "x-shopify-webhook-id": options.webhookId ?? `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
      "x-shopify-event-id": options.eventId ?? `11111111-1111-4111-8111-${String(counter).padStart(12, "0")}`,
      "x-shopify-api-version": options.apiVersion ?? "2026-10",
      "x-shopify-triggered-at": "2026-10-30T16:00:05.123456789Z",
    },
  };
}

/** A callback query as Shopify would send it, signed with `secret`. */
export function signedCallbackQuery(params: Record<string, string>, secret: string): URLSearchParams {
  const hmac = computeOauthHmac(secret, params);
  if (hmac === null) throw new Error("cannot sign");
  return new URLSearchParams({ ...params, hmac });
}
