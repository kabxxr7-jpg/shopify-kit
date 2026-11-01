import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeOauthHmac, computeWebhookHmac, oauthQueryMessage, verifyOauthHmac, verifyWebhookHmac } from "../src/hmac.ts";

const SECRET = "test_client_secret_not_real_0123456789";
const body = '{"id":5000001001,"name":"#1001"}';
const sign = (secret: string, raw: string): string => createHmac("sha256", secret).update(raw).digest("base64");

describe("webhook HMAC", () => {
  it("matches a published HMAC-SHA256 test vector (key / quick brown fox)", () => {
    const hex = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8";
    expect(computeWebhookHmac("key", "The quick brown fox jumps over the lazy dog")).toBe(Buffer.from(hex, "hex").toString("base64"));
  });

  it("accepts the correct base64 digest of the raw body", () => {
    expect(verifyWebhookHmac({ secrets: SECRET, rawBody: body, header: sign(SECRET, body) })).toBe(true);
  });

  it("accepts the body as bytes", () => {
    expect(verifyWebhookHmac({ secrets: SECRET, rawBody: new TextEncoder().encode(body), header: sign(SECRET, body) })).toBe(true);
  });

  it("rejects a body that differs by one byte", () => {
    expect(verifyWebhookHmac({ secrets: SECRET, rawBody: body.replace("1001", "1002"), header: sign(SECRET, body) })).toBe(false);
  });

  it("rejects a re-serialised body: the signature is over the exact bytes, not over the parsed JSON", () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(pretty).not.toBe(body);
    expect(verifyWebhookHmac({ secrets: SECRET, rawBody: pretty, header: sign(SECRET, body) })).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifyWebhookHmac({ secrets: "another_secret", rawBody: body, header: sign(SECRET, body) })).toBe(false);
  });

  it.each([undefined, null, ""])("rejects a missing header (%s)", (header) => {
    expect(verifyWebhookHmac({ secrets: SECRET, rawBody: body, header })).toBe(false);
  });

  it("rejects a hex digest where base64 is required", () => {
    const hex = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyWebhookHmac({ secrets: SECRET, rawBody: body, header: hex })).toBe(false);
  });

  it("rejects malformed base64 without throwing (wrong length, bad characters, truncated)", () => {
    const good = sign(SECRET, body);
    for (const bad of [good.slice(0, -1), `${good}A`, good.replace(/.$/, "!"), "AAAA", good.replace("=", "")]) {
      expect(verifyWebhookHmac({ secrets: SECRET, rawBody: body, header: bad })).toBe(false);
    }
  });

  it("accepts either secret while a rotation propagates, and rejects when neither matches", () => {
    const oldSecret = "old_secret_value";
    expect(verifyWebhookHmac({ secrets: [SECRET, oldSecret], rawBody: body, header: sign(oldSecret, body) })).toBe(true);
    expect(verifyWebhookHmac({ secrets: [SECRET, oldSecret], rawBody: body, header: sign(SECRET, body) })).toBe(true);
    expect(verifyWebhookHmac({ secrets: [SECRET, oldSecret], rawBody: body, header: sign("third", body) })).toBe(false);
  });

  it("never treats an empty secret as a match", () => {
    expect(verifyWebhookHmac({ secrets: "", rawBody: body, header: sign("", body) })).toBe(false);
    expect(verifyWebhookHmac({ secrets: [], rawBody: body, header: sign(SECRET, body) })).toBe(false);
  });

  it("compares with crypto.timingSafeEqual (a source-level guard: a timing difference cannot be unit-tested reliably)", () => {
    const src = readFileSync(new URL("../src/hmac.ts", import.meta.url), "utf8");
    expect(src).toContain("timingSafeEqual(expected, candidate)");
    expect(src).toContain("timingSafeEqual(expected, Buffer.from(supplied");
  });
});

describe("OAuth query HMAC", () => {
  const params = { shop: "harbour-pine-demo.myshopify.com", code: "abc123", state: "s1", timestamp: "1730000000" };

  it("signs the sorted key=value pairs joined with & (hex), without hmac", () => {
    const message = "code=abc123&shop=harbour-pine-demo.myshopify.com&state=s1&timestamp=1730000000";
    expect(oauthQueryMessage({ ...params, hmac: "ignored" })).toBe(message);
    expect(computeOauthHmac(SECRET, params)).toBe(createHmac("sha256", SECRET).update(message).digest("hex"));
  });

  it("is independent of the order the parameters arrive in", () => {
    const shuffled = new URLSearchParams([["timestamp", "1730000000"], ["state", "s1"], ["shop", params.shop], ["code", "abc123"]]);
    expect(computeOauthHmac(SECRET, shuffled)).toBe(computeOauthHmac(SECRET, params));
  });

  it("verifies a correct signature, upper-case hex included", () => {
    const hmac = computeOauthHmac(SECRET, params)!;
    expect(verifyOauthHmac(SECRET, { ...params, hmac })).toBe(true);
    expect(verifyOauthHmac(SECRET, { ...params, hmac: hmac.toUpperCase() })).toBe(true);
  });

  it("rejects a changed parameter, a changed secret and an added parameter", () => {
    const hmac = computeOauthHmac(SECRET, params)!;
    expect(verifyOauthHmac(SECRET, { ...params, code: "other", hmac })).toBe(false);
    expect(verifyOauthHmac("different", { ...params, hmac })).toBe(false);
    expect(verifyOauthHmac(SECRET, { ...params, extra: "1", hmac })).toBe(false);
  });

  it("rejects a missing, short or non-hex hmac", () => {
    expect(verifyOauthHmac(SECRET, params)).toBe(false);
    expect(verifyOauthHmac(SECRET, { ...params, hmac: "abcd" })).toBe(false);
    expect(verifyOauthHmac(SECRET, { ...params, hmac: "z".repeat(64) })).toBe(false);
  });

  it("refuses a repeated parameter instead of guessing which value was signed", () => {
    const dup = new URLSearchParams([["shop", params.shop], ["code", "a"], ["code", "b"]]);
    expect(oauthQueryMessage(dup)).toBeNull();
    expect(computeOauthHmac(SECRET, dup)).toBeNull();
    dup.set("hmac", "0".repeat(64));
    expect(verifyOauthHmac(SECRET, dup)).toBe(false);
  });

  it("does not accept a base64 webhook digest as an OAuth hmac, nor the reverse", () => {
    const hmac = computeOauthHmac(SECRET, params)!;
    expect(verifyWebhookHmac({ secrets: SECRET, rawBody: body, header: hmac })).toBe(false);
  });
});
