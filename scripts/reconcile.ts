// Aggregate orders and compare with a report, metric by metric, to the cent.
//   npm run reconcile                                   (shipped fixtures, shop currency)
//   npm run reconcile -- --mode presentment
//   npm run reconcile -- --via-mock                     (fetch the fixture orders through the local mock Admin API first)
//   npm run reconcile -- --orders my-orders.json --report my-report.json --tz Europe/Berlin --from 2026-10-01 --until 2026-10-31
// Exit code 0 = reconciled, 1 = differences, 2 = usage error.
// The shipped report was written by hand from Shopify's metric definitions; it is not an export from a store.
import { readFileSync } from "node:fs";
import { AdminClient } from "../src/admin-client.ts";
import { aggregateSales, AggregationError } from "../src/aggregate.ts";
import { buildOrdersSearch, fetchAllOrders, type Order } from "../src/orders.ts";
import { formatDiffs, reconcile, type ReportJson } from "../src/reconcile.ts";
import { MockShopify } from "../testing/mock-shopify.ts";
import { parseArgs } from "./args.ts";

const { flags } = parseArgs(process.argv.slice(2), ["mode", "orders", "report", "tz", "from", "until"]);
const mode = String(flags.get("mode") ?? "shop");
if (mode !== "shop" && mode !== "presentment") {
  console.error("--mode must be shop or presentment");
  process.exit(2);
}
const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const ordersPath = String(flags.get("orders") ?? new URL("../fixtures/orders.json", import.meta.url).pathname);
const reportPath = String(flags.get("report") ?? new URL(`../fixtures/shopify-report.${mode}.json`, import.meta.url).pathname);
const doc = read(ordersPath) as { orders: Order[] };
const report = read(reportPath) as ReportJson & { window?: { from?: string; until?: string; timeZone?: string } };

let orders = doc.orders;
if (flags.has("via-mock")) {
  const mock = await new MockShopify({ orders: doc.orders as unknown as Array<Record<string, unknown>> }).start();
  try {
    const client = new AdminClient({ shop: "harbour-pine-demo.myshopify.com", accessToken: "shpat_test_token_not_real", baseUrl: mock.baseUrl });
    orders = await fetchAllOrders(client, { mode, search: buildOrdersSearch({ excludeTest: false }), onPage: (p) => console.log(`  page ${p.pageNumber}: ${p.orders.length} order(s), requested cost ${p.result.extensions.cost?.requestedQueryCost}, actual ${p.result.extensions.cost?.actualQueryCost}`) });
    console.log(`fetched ${orders.length} orders through the mock Admin API (${mock.graphqlRequests().length} requests)`);
  } finally {
    await mock.stop();
  }
}

const timeZone = String(flags.get("tz") ?? report.window?.timeZone ?? report.shop?.timeZone ?? "");
if (!timeZone) {
  console.error("No time zone: pass --tz or put shop.timeZone in the report.");
  process.exit(2);
}
const from = flags.has("from") ? String(flags.get("from")) : report.window?.from;
const until = flags.has("until") ? String(flags.get("until")) : report.window?.until;
try {
  const result = aggregateSales(orders, { timeZone, currency: mode, ...(from ? { from } : {}), ...(until ? { until } : {}) });
  for (const issue of result.issues) console.log(`  ${issue.severity} ${issue.orderName} ${issue.code}: ${issue.message}`);
  const verdict = reconcile(result, report);
  console.log(formatDiffs(verdict));
  process.exit(verdict.ok ? 0 : 1);
} catch (error) {
  if (error instanceof AggregationError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
