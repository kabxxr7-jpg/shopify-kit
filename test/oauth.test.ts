import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockShopify } from "../testing/mock-shopify.ts";
import { TEST_SECRET, signedCallbackQuery } from "../testing/sign.ts";
import {
  STATE_COOKIE_NAME,
  TokenExchangeError,
  beginInstall,
  createNonceStore,
  exchangeAuthorizationCode,
  handleCallback,
  missingScopes,
  refreshAccessToken,
  validateOAuthConfig,
  type OAuthConfig,
} from "../src/oauth.ts";

const SHOP = "harbour-pine-demo.myshopify.com";
let mock: MockShopify;

beforeAll(async () => {
  mock = await new MockShopify().start();
});
afterAll(async () => {
  await mock.stop();
});

const tokenRequests = (): number => mock.requests.filter((r) => r.path === "/admin/oauth/access_token").length;
const config = (over: Partial<OAuthConfig> = {}): OAuthConfig => ({
  clientId: "test_client_id",
  clientSecret: TEST_SECRET,
  redirectUri: "http://localhost:4771/auth/callback",
  scopes: ["read_orders"],
  shopOrigin: () => mock.baseUrl,
  ...over,
});

/** Runs install, then builds the callback Shopify would send back for it. */
function prepare(cfg: OAuthConfig, shop = SHOP) {
  const nonces = createNonceStore();
  const start = beginInstall(cfg, { shop }, nonces);
  if (!start.ok) throw new Error("install failed");
  const code = mock.issueAuthorizationCode(shop);
  const query = (over: Record<string, string> = {}, secret = cfg.clientSecret) =>
    signedCallbackQuery({ code, shop, state: start.state, timestamp: String(Math.floor(Date.now() / 1000)), ...over }, secret);
  return { nonces, start, code, query };
}

describe("validateOAuthConfig", () => {
  it("accepts a normal config and http only on localhost", () => {
    expect(() => validateOAuthConfig(config())).not.toThrow();
    expect(() => validateOAuthConfig(config({ redirectUri: "https://app.example.invalid/auth/callback" }))).not.toThrow();
  });
  it.each([
    [{ clientId: "" }, /clientId/],
    [{ clientSecret: "" }, /clientSecret/],
    [{ scopes: [] }, /scope/],
    [{ scopes: ["read orders"] }, /invalid scope/],
    [{ scopes: ["READ_ORDERS"] }, /invalid scope/],
    [{ redirectUri: "http://app.example.invalid/cb" }, /https/],
    [{ redirectUri: "/auth/callback" }, /absolute URL/],
  ])("rejects %j", (over, message) => {
    expect(() => validateOAuthConfig(config(over as Partial<OAuthConfig>))).toThrow(message);
  });
});

describe("beginInstall", () => {
  it("redirects to the shop's authorize URL with client_id, scope, redirect_uri and state", () => {
    const nonces = createNonceStore();
    const { shopOrigin: _unused, ...base } = config();
    const cfg: OAuthConfig = { ...base, scopes: ["read_orders", "read_products"], redirectUri: "https://app.example.invalid/auth/callback" };
    const r = beginInstall(cfg, { shop: SHOP }, nonces);
    if (!r.ok) throw new Error("expected ok");
    const url = new URL(r.redirectUrl);
    expect(url.origin).toBe(`https://${SHOP}`);
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("test_client_id");
    expect(url.searchParams.get("scope")).toBe("read_orders,read_products");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.invalid/auth/callback");
    expect(url.searchParams.get("state")).toBe(r.state);
    expect(r.state).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sets a state cookie that is HttpOnly, SameSite=Lax and Secure on https", () => {
    const https = beginInstall(config({ redirectUri: "https://app.example.invalid/cb" }), { shop: SHOP }, createNonceStore());
    const http = beginInstall(config(), { shop: SHOP }, createNonceStore());
    if (!https.ok || !http.ok) throw new Error("expected ok");
    expect(https.setCookie).toBe(`${STATE_COOKIE_NAME}=${https.state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600; Secure`);
    expect(http.setCookie).not.toContain("Secure");
    expect(http.setCookie).toContain("HttpOnly");
  });

  it("returns a fresh state every time and remembers each", () => {
    const nonces = createNonceStore();
    const a = beginInstall(config(), { shop: SHOP }, nonces);
    const b = beginInstall(config(), { shop: SHOP }, nonces);
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.state).not.toBe(b.state);
    expect(nonces.size()).toBe(2);
  });

  it.each(["evil.example", `${SHOP}.attacker.example`, "", undefined, 42])("refuses shop %j without issuing a nonce", (shop) => {
    const nonces = createNonceStore();
    expect(beginInstall(config(), { shop }, nonces)).toEqual({ ok: false, status: 400, reason: "invalid_shop" });
    expect(nonces.size()).toBe(0);
  });

  it("lower-cases the shop and can ask for an online token", () => {
    const r = beginInstall(config({ online: true }), { shop: "Harbour-Pine-Demo.myshopify.com" }, createNonceStore());
    if (!r.ok) throw new Error("expected ok");
    expect(r.shop).toBe(SHOP);
    expect(r.redirectUrl).toContain("grant_options[]=per-user");
  });

  it("does not add the per-user option for the default offline token", () => {
    const r = beginInstall(config(), { shop: SHOP }, createNonceStore());
    if (!r.ok) throw new Error("expected ok");
    expect(r.redirectUrl).not.toContain("grant_options");
  });
});

describe("nonce store", () => {
  it("is single use", () => {
    const nonces = createNonceStore();
    const n = nonces.issue(SHOP);
    expect(nonces.consume(n, SHOP)).toBe(true);
    expect(nonces.consume(n, SHOP)).toBe(false);
  });
  it("burns a nonce presented for the wrong shop", () => {
    const nonces = createNonceStore();
    const n = nonces.issue(SHOP);
    expect(nonces.consume(n, "other-shop.myshopify.com")).toBe(false);
    expect(nonces.consume(n, SHOP)).toBe(false);
  });
  it("expires after the ttl and sweeps expired entries", () => {
    let t = 1_000;
    const nonces = createNonceStore({ ttlMs: 600, now: () => t });
    const n = nonces.issue(SHOP);
    t += 599;
    expect(nonces.size()).toBe(1);
    t += 1;
    expect(nonces.size()).toBe(0);
    expect(nonces.consume(n, SHOP)).toBe(false);
  });
  it("matches the shop case-insensitively and rejects unknown values", () => {
    const nonces = createNonceStore();
    const n = nonces.issue("Harbour-Pine-Demo.myshopify.com");
    expect(nonces.consume("nope", SHOP)).toBe(false);
    expect(nonces.consume(n, SHOP)).toBe(true);
  });
});

describe("handleCallback against the local mock token endpoint", () => {
  it("completes the happy path and returns an expiring offline token with a refresh token", async () => {
    const cfg = config();
    const { nonces, start, query } = prepare(cfg);
    const before = tokenRequests();
    const r = await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces });
    if (!r.ok) throw new Error(`expected ok, got ${r.reason} ${r.detail}`);
    expect(r.shop).toBe(SHOP);
    expect(r.tokens.accessToken).toMatch(/^shpat_/);
    expect(r.tokens.refreshToken).toMatch(/^shprt_/);
    expect(r.tokens.scope).toEqual(["read_orders", "read_all_orders"]);
    expect(tokenRequests()).toBe(before + 1);
    const last = mock.requests.filter((x) => x.path === "/admin/oauth/access_token").at(-1)!;
    const form = new URLSearchParams(last.body);
    expect(form.get("client_id")).toBe("test_client_id");
    expect(form.get("client_secret")).toBe(TEST_SECRET);
    expect(form.get("expiring")).toBe("1");
    expect(last.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("computes token expiry from the injected clock", async () => {
    const cfg = config({ now: () => 1_000_000 });
    const { nonces, start, query } = prepare(cfg);
    const r = await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces });
    if (!r.ok) throw new Error("expected ok");
    expect(r.tokens.expiresAt).toBe(1_000_000 + 3600 * 1000);
    expect(r.tokens.refreshTokenExpiresAt).toBe(1_000_000 + 7_776_000 * 1000);
  });

  it("does not send expiring=1 when expiring tokens are switched off", async () => {
    const cfg = config({ expiring: false });
    const { nonces, start, query } = prepare(cfg);
    await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces });
    const last = mock.requests.filter((x) => x.path === "/admin/oauth/access_token").at(-1)!;
    expect(new URLSearchParams(last.body).has("expiring")).toBe(false);
  });

  it("rejects an invalid shop before anything else and sends nothing", async () => {
    const cfg = config();
    const { nonces, start } = prepare(cfg);
    const before = tokenRequests();
    const q = signedCallbackQuery({ code: "c", shop: "evil.example", state: start.state, timestamp: "1" }, TEST_SECRET);
    expect(await handleCallback(cfg, { query: q, stateCookie: start.state, nonces })).toMatchObject({ ok: false, status: 400, reason: "invalid_shop" });
    expect(tokenRequests()).toBe(before);
  });

  it("rejects a wrong HMAC with 403 and sends nothing to Shopify", async () => {
    const cfg = config();
    const { nonces, start, query } = prepare(cfg);
    const before = tokenRequests();
    const r = await handleCallback(cfg, { query: query({}, "not the secret"), stateCookie: start.state, nonces });
    expect(r).toMatchObject({ ok: false, status: 403, reason: "invalid_hmac" });
    expect(tokenRequests()).toBe(before);
  });

  it("rejects a parameter changed after signing", async () => {
    const cfg = config();
    const { nonces, start, query } = prepare(cfg);
    const q = query();
    q.set("code", "swapped");
    expect(await handleCallback(cfg, { query: q, stateCookie: start.state, nonces })).toMatchObject({ reason: "invalid_hmac" });
  });

  it("rejects a callback with no state cookie, or a cookie that differs, and does not burn the nonce", async () => {
    const cfg = config();
    const { nonces, query } = prepare(cfg);
    const before = tokenRequests();
    expect(await handleCallback(cfg, { query: query(), stateCookie: undefined, nonces })).toMatchObject({ reason: "invalid_state" });
    expect(await handleCallback(cfg, { query: query(), stateCookie: "f".repeat(32), nonces })).toMatchObject({ reason: "invalid_state" });
    expect(tokenRequests()).toBe(before);
    expect(nonces.size()).toBe(1);
  });

  it("rejects a state the server never issued even if the attacker also sets the cookie to it", async () => {
    const cfg = config();
    const { nonces, query } = prepare(cfg);
    const forged = "a".repeat(32);
    const before = tokenRequests();
    const r = await handleCallback(cfg, { query: query({ state: forged }), stateCookie: forged, nonces });
    expect(r).toMatchObject({ ok: false, status: 403, reason: "invalid_state" });
    expect(tokenRequests()).toBe(before);
  });

  it("rejects a replayed callback (state is single use)", async () => {
    const cfg = config();
    const { nonces, start, query } = prepare(cfg);
    const q = query();
    expect((await handleCallback(cfg, { query: q, stateCookie: start.state, nonces })).ok).toBe(true);
    const before = tokenRequests();
    expect(await handleCallback(cfg, { query: q, stateCookie: start.state, nonces })).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(tokenRequests()).toBe(before);
  });

  it("rejects a state issued for a different shop", async () => {
    const cfg = config();
    const nonces = createNonceStore();
    const start = beginInstall(cfg, { shop: "other-shop.myshopify.com" }, nonces);
    if (!start.ok) throw new Error("expected ok");
    const q = signedCallbackQuery({ code: mock.issueAuthorizationCode(SHOP), shop: SHOP, state: start.state, timestamp: "1" }, TEST_SECRET);
    expect(await handleCallback(cfg, { query: q, stateCookie: start.state, nonces })).toMatchObject({ reason: "invalid_state" });
  });

  it("answers 400 missing_code when the signed query has no code", async () => {
    const cfg = config();
    const { nonces, start } = prepare(cfg);
    const q = signedCallbackQuery({ shop: SHOP, state: start.state, timestamp: "1" }, TEST_SECRET);
    expect(await handleCallback(cfg, { query: q, stateCookie: start.state, nonces })).toMatchObject({ ok: false, status: 400, reason: "missing_code" });
  });

  it("reports a code Shopify rejects (already used) as token_exchange_failed / 403", async () => {
    const cfg = config();
    const first = prepare(cfg);
    expect((await handleCallback(cfg, { query: first.query(), stateCookie: first.start.state, nonces: first.nonces })).ok).toBe(true);
    // second callback with the same (now spent) code but a fresh state
    const nonces = createNonceStore();
    const start = beginInstall(cfg, { shop: SHOP }, nonces);
    if (!start.ok) throw new Error("expected ok");
    const q = signedCallbackQuery({ code: first.code, shop: SHOP, state: start.state, timestamp: "1" }, TEST_SECRET);
    const r = await handleCallback(cfg, { query: q, stateCookie: start.state, nonces });
    expect(r).toMatchObject({ ok: false, status: 403, reason: "token_exchange_failed" });
  });

  it("answers 502 when the token endpoint fails with a 5xx", async () => {
    const cfg = config();
    const { nonces, start, query } = prepare(cfg);
    mock.inject({ kind: "token-status", times: 1, status: 503 });
    expect(await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces })).toMatchObject({ ok: false, status: 502, reason: "token_exchange_failed" });
  });

  it("answers 502 when the network fails", async () => {
    const cfg = config({ fetch: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch });
    const { nonces, start, query } = prepare(cfg);
    const r = await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces });
    expect(r).toMatchObject({ ok: false, status: 502, reason: "token_exchange_failed" });
    expect(r.ok ? "" : r.detail).toContain("ECONNRESET");
  });

  it("fails with missing_scopes when Shopify grants less than was requested", async () => {
    const cfg = config({ scopes: ["read_orders", "read_products"] });
    mock.grantedScopes = ["read_orders"];
    try {
      const { nonces, start, query } = prepare(cfg);
      const r = await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces });
      expect(r).toMatchObject({ ok: false, status: 403, reason: "missing_scopes" });
      expect(r.ok ? "" : r.detail).toContain("read_products");
    } finally {
      mock.grantedScopes = ["read_orders", "read_all_orders"];
    }
  });

  it("treats a write_x grant as covering read_x", async () => {
    const cfg = config();
    mock.grantedScopes = ["write_orders"];
    try {
      const { nonces, start, query } = prepare(cfg);
      expect((await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces })).ok).toBe(true);
    } finally {
      mock.grantedScopes = ["read_orders", "read_all_orders"];
    }
  });

  describe("optional timestamp check", () => {
    const nowSeconds = 1_800_000_000;
    const cfg = () => config({ maxTimestampAgeSeconds: 300, now: () => nowSeconds * 1000 });
    it("accepts a fresh timestamp", async () => {
      const { nonces, start, query } = prepare(cfg());
      expect((await handleCallback(cfg(), { query: query({ timestamp: String(nowSeconds - 100) }), stateCookie: start.state, nonces })).ok).toBe(true);
    });
    it.each([nowSeconds - 301, nowSeconds + 301, "abc"])("rejects timestamp %s", async (ts) => {
      const { nonces, start, query } = prepare(cfg());
      expect(await handleCallback(cfg(), { query: query({ timestamp: String(ts) }), stateCookie: start.state, nonces })).toMatchObject({ reason: "stale_timestamp" });
    });
    it("is off by default", async () => {
      const c = config();
      const { nonces, start, query } = prepare(c);
      expect((await handleCallback(c, { query: query({ timestamp: "1" }), stateCookie: start.state, nonces })).ok).toBe(true);
    });
  });
});

describe("exchangeAuthorizationCode", () => {
  const stub = (response: Response, seen: { init?: RequestInit } = {}): typeof fetch =>
    (async (_url: unknown, init?: RequestInit) => {
      seen.init = init as RequestInit;
      return response;
    }) as unknown as typeof fetch;

  it("never follows redirects (a 307 would resend the client secret) and treats one as a failure", async () => {
    const seen: { init?: RequestInit } = {};
    const cfg = config({ fetch: stub(new Response(null, { status: 307, headers: { location: "https://attacker.example/steal" } }), seen) });
    await expect(exchangeAuthorizationCode(cfg, SHOP, "code")).rejects.toMatchObject({ name: "TokenExchangeError", status: 307 });
    expect(seen.init?.redirect).toBe("manual");
  });

  it("rejects a body that is not JSON, or has no access_token", async () => {
    await expect(exchangeAuthorizationCode(config({ fetch: stub(new Response("<html>", { status: 200 })) }), SHOP, "c")).rejects.toThrow(/not valid JSON/);
    await expect(exchangeAuthorizationCode(config({ fetch: stub(Response.json({ scope: "read_orders" })) }), SHOP, "c")).rejects.toThrow(/no access_token/);
    await expect(exchangeAuthorizationCode(config({ fetch: stub(Response.json("nope")) }), SHOP, "c")).rejects.toThrow(TokenExchangeError);
  });

  it("refuses an invalid shop domain before sending the secret anywhere", async () => {
    const before = tokenRequests();
    await expect(exchangeAuthorizationCode(config(), "evil.example", "c")).rejects.toThrow(/invalid shop/);
    expect(tokenRequests()).toBe(before);
  });
});

describe("refreshAccessToken", () => {
  async function installed() {
    const cfg = config();
    const { nonces, start, query } = prepare(cfg);
    const r = await handleCallback(cfg, { query: query(), stateCookie: start.state, nonces });
    if (!r.ok || !r.tokens.refreshToken) throw new Error("install failed");
    return { cfg, tokens: r.tokens };
  }

  it("rotates: returns a new access and refresh token, and the old refresh token stops working", async () => {
    const { cfg, tokens } = await installed();
    const first = await refreshAccessToken(cfg, SHOP, tokens.refreshToken!);
    if (first.status !== "refreshed") throw new Error(`expected refreshed, got ${first.status}`);
    expect(first.tokens.accessToken).not.toBe(tokens.accessToken);
    expect(first.tokens.refreshToken).not.toBe(tokens.refreshToken);
    expect(await refreshAccessToken(cfg, SHOP, tokens.refreshToken!)).toEqual({ status: "reauthorize" });
    const second = await refreshAccessToken(cfg, SHOP, first.tokens.refreshToken!);
    expect(second.status).toBe("refreshed");
  });

  it("sends grant_type=refresh_token with client credentials", async () => {
    const { cfg, tokens } = await installed();
    await refreshAccessToken(cfg, SHOP, tokens.refreshToken!);
    const last = mock.requests.filter((x) => x.path === "/admin/oauth/access_token").at(-1)!;
    const form = new URLSearchParams(last.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(tokens.refreshToken);
    expect(form.get("client_secret")).toBe(TEST_SECRET);
  });

  it("answers reauthorize for an unknown refresh token (401)", async () => {
    expect(await refreshAccessToken(config(), SHOP, "shprt_unknown")).toEqual({ status: "reauthorize" });
  });

  it.each([429, 500, 503])("answers retry for HTTP %i, keeping the same refresh token", async (status) => {
    const { cfg, tokens } = await installed();
    mock.inject({ kind: "token-status", times: 1, status });
    expect(await refreshAccessToken(cfg, SHOP, tokens.refreshToken!)).toEqual({ status: "retry" });
    expect((await refreshAccessToken(cfg, SHOP, tokens.refreshToken!)).status).toBe("refreshed");
  });

  it("answers retry on a network error and failed on another 4xx", async () => {
    const down = config({ fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await refreshAccessToken(down, SHOP, "x")).toEqual({ status: "retry" });
    mock.inject({ kind: "token-status", times: 1, status: 400 });
    expect(await refreshAccessToken(config(), SHOP, "x")).toEqual({ status: "failed", httpStatus: 400 });
  });

  it("refuses an invalid shop", async () => {
    await expect(refreshAccessToken(config(), "evil.example", "x")).rejects.toThrow(/invalid shop/);
  });
});

describe("missingScopes", () => {
  it.each([
    [["read_orders"], ["read_orders"], []],
    [["read_orders"], ["write_orders"], []],
    [["write_orders"], ["read_orders"], ["write_orders"]],
    [["read_orders", "read_products"], ["read_orders"], ["read_products"]],
    [["read_orders"], [], ["read_orders"]],
    [["unauthenticated_read_product_listings"], ["write_product_listings"], ["unauthenticated_read_product_listings"]],
  ])("requested %j, granted %j -> missing %j", (requested, granted, missing) => {
    expect(missingScopes(requested, granted)).toEqual(missing);
  });
});
