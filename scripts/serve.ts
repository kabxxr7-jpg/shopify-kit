// Local app: GET /health, POST /webhooks, GET /auth/install, GET /auth/callback, backed by SQLite.
//   SHOPIFY_API_KEY=... SHOPIFY_API_SECRET=... APP_URL=https://your-tunnel.example npm run serve
//   npm run serve -- --demo        (fictional secret + a local mock Shopify for the token endpoint and the Admin API)
// Ports: only 4770-4789 are used here.
import { mkdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createSqliteCompliance } from "../src/compliance.ts";
import { openDb } from "../src/db.ts";
import { createSqliteStore } from "../src/dedupe.ts";
import { createOrderHandlers } from "../src/handlers.ts";
import { createNonceStore, type OAuthConfig } from "../src/oauth.ts";
import { createAppServer } from "../src/server.ts";
import { MockShopify } from "../testing/mock-shopify.ts";
import { listenInRange } from "../testing/ports.ts";
import { TEST_SECRET } from "../testing/sign.ts";
import { parseArgs } from "./args.ts";

const { flags } = parseArgs(process.argv.slice(2), ["db", "port"]);
const demo = flags.has("demo");
const secret = process.env["SHOPIFY_API_SECRET"] ?? (demo ? TEST_SECRET : undefined);
const clientId = process.env["SHOPIFY_API_KEY"] ?? (demo ? "test_client_id" : undefined);
if (!secret || !clientId) {
  console.error("Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET (and APP_URL), or pass --demo to use fictional values and a local mock Shopify.");
  process.exit(2);
}
const dbPath = String(flags.get("db") ?? (demo ? ":memory:" : "data/shopify-kit.db"));
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);

let mock: MockShopify | null = null;
if (demo) {
  const orders = (JSON.parse(readFileSync(new URL("../fixtures/orders.json", import.meta.url), "utf8")) as { orders: Array<Record<string, unknown>> }).orders;
  mock = await new MockShopify({ orders }).start();
}
const preferred = flags.has("port") ? Number(flags.get("port")) : undefined;

// The server needs to know its own origin for the redirect URI; bind first with a placeholder config, then fix it up.
const origin = { value: process.env["APP_URL"] ?? "" };
const oauthConfig: OAuthConfig = {
  clientId,
  clientSecret: secret,
  get redirectUri() {
    return `${origin.value}/auth/callback`;
  },
  scopes: ["read_orders"],
  ...(mock ? { shopOrigin: () => mock!.baseUrl } : {}),
};
const server = createAppServer({
  webhook: { secrets: secret, store: createSqliteStore({ db }), compliance: createSqliteCompliance(db), handlers: createOrderHandlers(db) },
  oauth: { config: oauthConfig, nonces: createNonceStore(), db },
  log: (line) => console.log(line),
});
const port = await listenInRange(server, preferred);
if (!origin.value) origin.value = `http://localhost:${port}`;
console.log(`app listening on http://127.0.0.1:${port}  (database: ${dbPath})${demo ? "  [demo secret]" : ""}`);
console.log(`  health   GET  ${origin.value}/health`);
console.log(`  install  GET  ${origin.value}/auth/install?shop=<shop>.myshopify.com`);
console.log(`  webhooks POST ${origin.value}/webhooks`);
if (mock) console.log(`mock Shopify (token endpoint + Admin API) on ${mock.baseUrl}, serving ${mock.orders.length} fixture orders`);

const stop = (): void => {
  server.close();
  void mock?.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
