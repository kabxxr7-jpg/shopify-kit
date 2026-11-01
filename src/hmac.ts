// The two HMAC checks Shopify uses. They look similar and are easy to mix up:
//
//  * Webhooks: HMAC-SHA256 of the RAW request body, keyed with the app's client secret, BASE64-encoded,
//    in the X-Shopify-Hmac-SHA256 header. (docs: "Verify webhook deliveries")
//  * OAuth callback: HMAC-SHA256 of the query string without `hmac`, parameters sorted alphabetically and
//    joined as key=value with `&`, keyed with the client secret, HEX-encoded, in the `hmac` query parameter.
//    (docs: "Authenticate a standalone or API-only app", section "Verify the HMAC")
//
// Both comparisons are constant-time (crypto.timingSafeEqual) on the decoded bytes, and a header that is not
// well-formed is rejected before any comparison (timingSafeEqual throws on unequal lengths).
import { createHmac, timingSafeEqual } from "node:crypto";

export type Secret = string;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes -> 44 base64 characters, one '=' pad
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

export function computeWebhookHmac(secret: Secret, rawBody: string | Uint8Array): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

/**
 * True when `header` is the base64 HMAC-SHA256 of `rawBody` under at least one of `secrets`
 * (an array lets you accept the old and the new secret while a rotation propagates; the docs say a
 * rotated secret can take up to an hour to be used for the digest).
 */
export function verifyWebhookHmac(params: { secrets: Secret | readonly Secret[]; rawBody: string | Uint8Array; header: string | null | undefined }): boolean {
  const { rawBody, header } = params;
  if (typeof header !== "string" || !BASE64_SHA256.test(header)) return false;
  const candidate = Buffer.from(header, "base64");
  const secrets = typeof params.secrets === "string" ? [params.secrets] : [...params.secrets];
  let matched = false;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    // no early exit: every secret is compared, so timing does not reveal which one matched
    if (timingSafeEqual(expected, candidate)) matched = true;
  }
  return matched;
}

export type QueryParams = URLSearchParams | Record<string, string | readonly string[] | undefined>;

/** Returns [key, value] pairs, or null when a key is repeated (the docs do not define the message format for repeats). */
function toPairs(params: QueryParams): Array<[string, string]> | null {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  const entries: Array<[string, string | readonly string[] | undefined]> =
    params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    if (typeof value !== "string") return null; // array value = repeated key
    if (seen.has(key)) return null;
    seen.add(key);
    pairs.push([key, value]);
  }
  return pairs;
}

/**
 * The string that is signed in the OAuth callback: every parameter except `hmac`, sorted alphabetically by key,
 * as `key=value` joined with `&`, using the decoded values (as the docs' sample does with Express' parsed query).
 * Returns null if a key occurs more than once.
 */
export function oauthQueryMessage(params: QueryParams): string | null {
  const pairs = toPairs(params);
  if (pairs === null) return null;
  return pairs
    .filter(([key]) => key !== "hmac")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function computeOauthHmac(secret: Secret, params: QueryParams): string | null {
  const message = oauthQueryMessage(params);
  if (message === null) return null;
  return createHmac("sha256", secret).update(message).digest("hex");
}

/** True when the `hmac` parameter matches the signature of the other parameters. */
export function verifyOauthHmac(secret: Secret, params: QueryParams): boolean {
  const supplied = params instanceof URLSearchParams ? params.get("hmac") : params["hmac"];
  if (typeof supplied !== "string" || !HEX_SHA256.test(supplied)) return false;
  const message = oauthQueryMessage(params);
  if (message === null || secret.length === 0) return false;
  const expected = createHmac("sha256", secret).update(message).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}
