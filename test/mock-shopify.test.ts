// The mock Admin API is a test double, so it gets its own tests: if it were lenient, every client test above would prove less than it seems to.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockShopify } from "../testing/mock-shopify.ts";
import { PORT_MAX, PORT_MIN, closeServer, listenInRange } from "../testing/ports.ts";
import { ROOT, SCHEMA } from "../testing/schema.ts";

const doc = JSON.parse(readFileSync(new URL("../fixtures/orders.json", import.meta.url), "utf8")) as { orders: Array<Record<string, unknown>> };
let mock: MockShopify;
const clock = { t: 1_000_000 };

beforeAll(async () => {
  mock = await new MockShopify({ orders: doc.orders, accessTokens: ["tok"], now: () => clock.t }).start();
});
afterAll(async () => {
  await mock.stop();
});

async function gql(query: string, variables: Record<string, unknown> = {}, headers: Record<string, string> = { "x-shopify-access-token": "tok" }, version = "2026-10") {
  const res = await fetch(`${mock.baseUrl}/admin/api/${version}/graphql.json`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ query, variables }) });
  return { status: res.status, headers: res.headers, json: (await res.json()) as any };
}
const errorsOf = (r: { json: any }): string => JSON.stringify(r.json.errors);

describe("ports", () => {
  it("binds inside 4770-4789 only, on 127.0.0.1", async () => {
    expect(mock.port).toBeGreaterThanOrEqual(PORT_MIN);
    expect(mock.port).toBeLessThanOrEqual(PORT_MAX);
    expect(mock.baseUrl).toBe(`http://127.0.0.1:${mock.port}`);
  });
  it("walks to the next free port when one is taken", async () => {
    const squatters = [];
    const probe = createServer();
    squatters.push(probe);
    const first = await listenInRange(probe);
    const second = createServer();
    squatters.push(second);
    const p2 = await listenInRange(second, first);
    expect(p2).not.toBe(first);
    expect(p2).toBeGreaterThanOrEqual(PORT_MIN);
    expect(p2).toBeLessThanOrEqual(PORT_MAX);
    await Promise.all(squatters.map((s) => closeServer(s)));
  });
});

describe("authentication and routing", () => {
  it("answers 401 without a valid access token header", async () => {
    expect((await gql("query { shop { name } }", {}, {})).status).toBe(401);
    expect((await gql("query { shop { name } }", {}, { "x-shopify-access-token": "wrong" })).status).toBe(401);
  });
  it("answers 404 for any other route and 405-ish nothing for GET on graphql", async () => {
    expect((await fetch(`${mock.baseUrl}/nope`)).status).toBe(404);
    expect((await fetch(`${mock.baseUrl}/admin/api/2026-10/graphql.json`)).status).toBe(404);
  });
  it("answers 400 for a body that is not JSON", async () => {
    const res = await fetch(`${mock.baseUrl}/admin/api/2026-10/graphql.json`, { method: "POST", headers: { "x-shopify-access-token": "tok" }, body: "nope" });
    expect(res.status).toBe(400);
  });
});

describe("validation (an invented field must fail)", () => {
  it("rejects a field that is not in the schema, on any level", async () => {
    expect(errorsOf(await gql("query { shop { nope } }"))).toContain("doesn't exist on type 'Shop'");
    expect(errorsOf(await gql("query { nope }"))).toContain("doesn't exist on type 'QueryRoot'");
    expect(errorsOf(await gql("query { orders(first: 1) { nodes { totalPriceSet { shopMoney { cents } } } } }"))).toContain("doesn't exist on type 'MoneyV2'");
    expect(errorsOf(await gql("query { orders(first: 1) { nodes { total_price } } }"))).toContain("doesn't exist on type 'Order'");
  });
  it("rejects selecting inside a scalar and a missing selection on an object", async () => {
    expect(errorsOf(await gql("query { shop { name { x } } }"))).toContain("Selections can't be made on scalars");
    expect(errorsOf(await gql("query { orders(first: 1) { nodes { totalPriceSet } } }"))).toContain("must have selections");
  });
  it("requires first on a connection and caps it at 250", async () => {
    expect(errorsOf(await gql("query { orders { nodes { id } } }"))).toContain("first");
    expect(errorsOf(await gql("query { orders(first: 251) { nodes { id } } }"))).toContain("250");
  });
  it("rejects an invalid sort key and an invalid cursor", async () => {
    expect(errorsOf(await gql("query { orders(first: 1, sortKey: BANANA) { nodes { id } } }"))).toContain("sortKey");
    expect(errorsOf(await gql('query { orders(first: 1, after: "garbage") { nodes { id } } }'))).toContain("Invalid cursor");
  });
  it("says so for syntax it does not support, instead of guessing", async () => {
    expect(errorsOf(await gql("query { a: shop { name } }"))).toContain("aliases");
    expect(errorsOf(await gql("query { ...F }"))).toContain("fragments");
    expect(errorsOf(await gql("mutation { orderCancel }"))).toContain("queries only");
    expect(errorsOf(await gql('query { orders(first: 1, query: "email:x@y.z") { nodes { id } } }'))).toContain("does not understand");
  });
  it("every field in the schema has a definition (guards the schema table against typos in field kinds)", () => {
    for (const [type, fields] of Object.entries(SCHEMA)) {
      for (const [name, def] of Object.entries(fields)) {
        if (def.kind !== "scalar") expect(SCHEMA[def.type!], `${type}.${name} -> ${def.type}`).toBeDefined();
      }
    }
    for (const def of Object.values(ROOT)) expect(SCHEMA[def.type!]).toBeDefined();
  });
});

describe("data", () => {
  it("returns only the selected fields", async () => {
    const r = await gql("query { orders(first: 1) { nodes { name test } } }");
    expect(Object.keys(r.json.data.orders.nodes[0])).toEqual(["name", "test"]);
  });
  it("pages with opaque cursors and reports hasNextPage / endCursor", async () => {
    const a = await gql("query { orders(first: 4) { pageInfo { hasNextPage endCursor } nodes { name } } }");
    expect(a.json.data.orders.pageInfo.hasNextPage).toBe(true);
    const b = await gql("query($c: String) { orders(first: 4, after: $c) { pageInfo { hasNextPage endCursor } nodes { name } } }", { c: a.json.data.orders.pageInfo.endCursor });
    const c = await gql("query($c: String) { orders(first: 4, after: $c) { pageInfo { hasNextPage } nodes { name } } }", { c: b.json.data.orders.pageInfo.endCursor });
    expect(c.json.data.orders.pageInfo.hasNextPage).toBe(false);
    expect([...a.json.data.orders.nodes, ...b.json.data.orders.nodes, ...c.json.data.orders.nodes]).toHaveLength(10);
  });
  it("filters by updated_at and test, and can reverse the order", async () => {
    const since = await gql(`query { orders(first: 50, query: "updated_at:>='2026-11-03T00:00:00Z'") { nodes { name } } }`);
    expect(since.json.data.orders.nodes.map((n: any) => n.name)).toEqual(["#1004", "#1008"]); // Shopify's default sort is PROCESSED_AT
    const noTest = await gql(`query { orders(first: 50, query: "test:false") { nodes { name } } }`);
    expect(noTest.json.data.orders.nodes).toHaveLength(9);
    const rev = await gql("query { orders(first: 2, sortKey: UPDATED_AT, reverse: true) { nodes { name } } }");
    expect(rev.json.data.orders.nodes.map((n: any) => n.name)).toEqual(["#1004", "#1008"]);
  });
  it("truncates a plain list at its first argument and flags a nested connection's hasNextPage", async () => {
    const r = await gql("query { orders(first: 10) { nodes { name lineItems(first: 1) { pageInfo { hasNextPage } nodes { id } } } } }");
    const o1003 = r.json.data.orders.nodes.find((n: any) => n.name === "#1003");
    expect(o1003.lineItems.nodes).toHaveLength(1);
    expect(o1003.lineItems.pageInfo.hasNextPage).toBe(true);
  });
  it("answers the shop query", async () => {
    expect((await gql("query { shop { ianaTimezone currencyCode } }")).json.data.shop).toEqual({ ianaTimezone: "America/Toronto", currencyCode: "CAD" });
  });
});

describe("cost model and bucket", () => {
  it("reports requested and actual cost with throttleStatus", async () => {
    const r = await gql("query { shop { name } }");
    expect(r.json.extensions.cost.requestedQueryCost).toBe(1);
    expect(r.json.extensions.cost.throttleStatus).toMatchObject({ maximumAvailable: 1000, restoreRate: 100 });
  });
  it("charges connections by their first argument, not by the data returned (requested > actual)", async () => {
    const r = await gql("query { orders(first: 100) { pageInfo { hasNextPage } nodes { id } } }");
    expect(r.json.extensions.cost.requestedQueryCost).toBe(1 + 1 + 100);
    expect(r.json.extensions.cost.actualQueryCost).toBeLessThan(r.json.extensions.cost.requestedQueryCost);
  });
  it("rejects a query over 1000 points with MAX_COST_EXCEEDED before touching the bucket", async () => {
    const before = (await gql("query { shop { name } }")).json.extensions.cost.throttleStatus.currentlyAvailable;
    const r = await gql("query { orders(first: 250) { nodes { id lineItems(first: 10) { nodes { id } } } } }");
    expect(r.json.errors[0].extensions.code).toBe("MAX_COST_EXCEEDED");
    const after = (await gql("query { shop { name } }")).json.extensions.cost.throttleStatus.currentlyAvailable;
    expect(after).toBeGreaterThanOrEqual(before - 1);
  });
  it("answers each injected fault once and only for as many times as asked", async () => {
    mock.inject({ kind: "internal-error", times: 2 });
    expect((await gql("query { shop { name } }")).json.errors[0].extensions.code).toBe("INTERNAL_SERVER_ERROR");
    expect((await gql("query { shop { name } }")).json.errors[0].extensions.code).toBe("INTERNAL_SERVER_ERROR");
    expect((await gql("query { shop { name } }")).json.data.shop.name).toBeDefined();
  });
  it("sets x-shopify-api-version to the version it answered with", async () => {
    expect((await gql("query { shop { name } }", {}, { "x-shopify-access-token": "tok" }, "2026-04")).headers.get("x-shopify-api-version")).toBe("2026-04");
    expect((await gql("query { shop { name } }", {}, { "x-shopify-access-token": "tok" }, "2019-01")).headers.get("x-shopify-api-version")).toBe("2026-01");
  });
});

describe("token endpoint", () => {
  const post = async (form: Record<string, string>) => {
    const res = await fetch(`${mock.baseUrl}/admin/oauth/access_token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    return { status: res.status, json: (await res.json()) as any };
  };
  const creds = { client_id: "test_client_id", client_secret: "test_client_secret_not_real_0123456789" };
  it("403 for wrong client credentials, 400 for an unknown or reused code", async () => {
    expect((await post({ ...creds, client_secret: "x", code: "c" })).status).toBe(403);
    expect((await post({ ...creds, code: "unknown" })).status).toBe(400);
    const code = mock.issueAuthorizationCode("harbour-pine-demo.myshopify.com");
    expect((await post({ ...creds, code })).status).toBe(200);
    expect((await post({ ...creds, code })).status).toBe(400);
  });
  it("issues a token that the GraphQL endpoint then accepts", async () => {
    const code = mock.issueAuthorizationCode("harbour-pine-demo.myshopify.com");
    const { json } = await post({ ...creds, code });
    expect((await gql("query { shop { name } }", {}, { "x-shopify-access-token": json.access_token })).status).toBe(200);
  });
});
