import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminClient } from "../src/admin-client.ts";
import { aggregateSales } from "../src/aggregate.ts";
import { createSqliteCompliance } from "../src/compliance.ts";
import { openDb, type Db } from "../src/db.ts";
import { createSqliteStore } from "../src/dedupe.ts";
import { createOrderHandlers } from "../src/handlers.ts";
import { createNonceStore, type OAuthConfig } from "../src/oauth.ts";
import { fetchAllOrders, fetchShopInfo, buildOrdersSearch } from "../src/orders.ts";
import { reconcile, type ReportJson } from "../src/reconcile.ts";
import { createAppServer } from "../src/server.ts";
import { MockShopify } from "../testing/mock-shopify.ts";
import { orderPayload, shopRedactPayload, SHOP_DOMAIN } from "../testing/payloads.ts";
import { closeServer, listenInRange } from "../testing/ports.ts";
import { TEST_SECRET, delivery, signedCallbackQuery } from "../testing/sign.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/orders.json", import.meta.url), "utf8")) as { orders: Array<Record<string, unknown>> };
const report = JSON.parse(readFileSync(new URL("../fixtures/shopify-report.shop.json", import.meta.url), "utf8")) as ReportJson;

let mock: MockShopify;
let app: Server;
let base = "";
let db: Db;
let logs: string[] = [];
let nonces = createNonceStore();

async function start(over: { maxBodyBytes?: number } = {}) {
  mock = await new MockShopify({ orders: fixture.orders }).start();
  db = openDb();
  logs = [];
  nonces = createNonceStore();
  const port = await listenInRange((app = createAppServer({
    webhook: { secrets: TEST_SECRET, store: createSqliteStore({ db }), compliance: createSqliteCompliance(db), handlers: createOrderHandlers(db) },
    ...(over.maxBodyBytes !== undefined ? { maxBodyBytes: over.maxBodyBytes } : {}),
    oauth: { config: oauthConfig(), nonces, db },
    log: (line) => logs.push(line),
  })));
  base = `http://127.0.0.1:${port}`;
}
const oauthConfig = (): OAuthConfig => ({ clientId: "test_client_id", clientSecret: TEST_SECRET, redirectUri: "http://localhost:4771/auth/callback", scopes: ["read_orders"], shopOrigin: () => mock.baseUrl });

beforeEach(() => start());
afterEach(async () => {
  await closeServer(app);
  await mock.stop();
});

const post = (d: { rawBody: string; headers: Record<string, string> }, path = "/webhooks") => fetch(`${base}${path}`, { method: "POST", headers: d.headers, body: d.rawBody });

describe("HTTP surface", () => {
  it("GET /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts a signed webhook over real HTTP, using the raw bytes (pretty-printed JSON, unicode and an emoji)", async () => {
    const raw = '{\n  "id": 5000001001,\n  "name": "#1001 café 🌲",\n  "updated_at": "2026-10-30T14:00:05Z"\n}';
    const res = await post(delivery(null, { topic: "orders/create", rawBody: raw }));
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT name FROM orders_seen").get()).toEqual({ name: "#1001 café 🌲" });
  });

  it("answers 401 for a forged webhook and stores nothing", async () => {
    const res = await post(delivery(orderPayload(), { topic: "orders/create", secret: "forged" }));
    expect(res.status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders_seen").get()).toEqual({ n: 0 });
  });

  it("answers 413 for a body over the limit, and 405 for GET on the webhook path", async () => {
    await closeServer(app);
    await mock.stop();
    await start({ maxBodyBytes: 200 });
    const big = delivery(null, { topic: "orders/create", rawBody: JSON.stringify({ id: 1, padding: "x".repeat(500) }) });
    expect((await post(big)).status).toBe(413);
    expect((await fetch(`${base}/webhooks`)).status).toBe(405);
    expect((await fetch(`${base}/webhooks`)).headers.get("allow")).toBe("POST");
  });

  it("answers 404 for anything else", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(404);
  });

  it("answers the compliance topics with 200 over HTTP and 401 on a bad HMAC", async () => {
    expect((await post(delivery(shopRedactPayload(), { topic: "shop/redact", secret: "forged" }))).status).toBe(401);
    expect((await post(delivery(shopRedactPayload(), { topic: "shop/redact" }))).status).toBe(200);
  });

  it("the request log has no payloads, e-mail addresses, secrets or tokens", async () => {
    await post(delivery(orderPayload(), { topic: "orders/create" }));
    await post(delivery(orderPayload(), { topic: "orders/create", secret: "forged" }));
    expect(logs.length).toBe(2);
    const text = logs.join("\n");
    expect(text).not.toContain("ada@example.invalid");
    expect(text).not.toContain(TEST_SECRET);
    expect(text).toContain("orders/create");
  });
});

describe("install flow over HTTP, against the local mock token endpoint", () => {
  async function install(shop = SHOP_DOMAIN) {
    const start = await fetch(`${base}/auth/install?shop=${shop}`, { redirect: "manual" });
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const location = new URL(start.headers.get("location") ?? "http://none.invalid");
    return { start, cookie, state: location.searchParams.get("state") ?? "", location };
  }
  const callback = (query: URLSearchParams, cookie: string) => fetch(`${base}/auth/callback?${query.toString()}`, { headers: cookie ? { cookie } : {} });

  it("redirects to the shop's authorize URL and sets the state cookie", async () => {
    const { start, location, cookie, state } = await install();
    expect(start.status).toBe(302);
    expect(location.pathname).toBe("/admin/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("test_client_id");
    expect(cookie).toBe(`shopify_oauth_state=${state}`);
    expect(start.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("refuses an invalid shop with 400 and never redirects", async () => {
    const res = await fetch(`${base}/auth/install?shop=evil.example`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("completes the callback: stores the offline token, clears the cookie, and the token works against the Admin API", async () => {
    const { cookie, state } = await install();
    const code = mock.issueAuthorizationCode(SHOP_DOMAIN);
    const res = await callback(signedCallbackQuery({ code, shop: SHOP_DOMAIN, state, timestamp: "1730000000" }, TEST_SECRET), cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installed: true, shop: SHOP_DOMAIN });
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    const row = db.prepare("SELECT access_token, scope, refresh_token FROM shops").get() as { access_token: string; scope: string; refresh_token: string };
    expect(row.access_token).toMatch(/^shpat_/);
    expect(row.refresh_token).toMatch(/^shprt_/);
    expect(row.scope).toBe("read_orders,read_all_orders");
    const client = new AdminClient({ shop: SHOP_DOMAIN, accessToken: row.access_token, baseUrl: mock.baseUrl });
    expect((await fetchShopInfo(client)).currencyCode).toBe("CAD");
    expect(logs.join("\n")).not.toContain(row.access_token);
  });

  it("rejects a forged callback (bad HMAC), a callback without the cookie, and a replay", async () => {
    const { cookie, state } = await install();
    const code = mock.issueAuthorizationCode(SHOP_DOMAIN);
    const params = { code, shop: SHOP_DOMAIN, state, timestamp: "1730000000" };
    expect((await callback(signedCallbackQuery(params, "forged-secret"), cookie)).status).toBe(403);
    expect((await callback(signedCallbackQuery(params, TEST_SECRET), "")).status).toBe(403);
    expect((await callback(signedCallbackQuery(params, TEST_SECRET), cookie)).status).toBe(200);
    expect((await callback(signedCallbackQuery(params, TEST_SECRET), cookie)).status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shops").get()).toEqual({ n: 1 });
  });

  it("reinstalling the same shop replaces its token instead of adding a second row", async () => {
    for (let i = 0; i < 2; i++) {
      const { cookie, state } = await install();
      const code = mock.issueAuthorizationCode(SHOP_DOMAIN);
      expect((await callback(signedCallbackQuery({ code, shop: SHOP_DOMAIN, state, timestamp: "1" }, TEST_SECRET), cookie)).status).toBe(200);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM shops").get()).toEqual({ n: 1 });
  });

  it("app/uninstalled removes the stored token", async () => {
    const { cookie, state } = await install();
    const code = mock.issueAuthorizationCode(SHOP_DOMAIN);
    await callback(signedCallbackQuery({ code, shop: SHOP_DOMAIN, state, timestamp: "1" }, TEST_SECRET), cookie);
    expect((await post(delivery({}, { topic: "app/uninstalled" }))).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM shops").get()).toEqual({ n: 0 });
  });
});

describe("the whole chain: install -> token -> Admin API -> aggregate -> reconcile", () => {
  it("fetches the fixture orders with the token from the install and reconciles with the report to the cent", async () => {
    const start = await fetch(`${base}/auth/install?shop=${SHOP_DOMAIN}`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
    const code = mock.issueAuthorizationCode(SHOP_DOMAIN);
    await fetch(`${base}/auth/callback?${signedCallbackQuery({ code, shop: SHOP_DOMAIN, state, timestamp: "1" }, TEST_SECRET).toString()}`, { headers: { cookie } });
    const { access_token } = db.prepare("SELECT access_token FROM shops WHERE shop_domain = ?").get(SHOP_DOMAIN) as { access_token: string };

    const client = new AdminClient({ shop: SHOP_DOMAIN, accessToken: access_token, baseUrl: mock.baseUrl, apiVersion: "2026-10" });
    const shop = await fetchShopInfo(client);
    const orders = await fetchAllOrders(client, { search: buildOrdersSearch({ excludeTest: false }) });
    expect(orders).toHaveLength(10);
    const result = aggregateSales(orders, { timeZone: shop.ianaTimezone, from: "2026-10-29", until: "2026-11-03" });
    const verdict = reconcile(result, report);
    expect(verdict.diffs).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});
