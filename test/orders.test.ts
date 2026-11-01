import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminClient, QueryCostError } from "../src/admin-client.ts";
import { DEFAULT_NESTED_LIMITS, MAX_PAGE_SIZE, OrderShapeError, PAGINATION_CAP, PaginationError, buildOrdersQuery, buildOrdersSearch, fetchAllOrders, fetchShopInfo, iterateOrders, type Order } from "../src/orders.ts";
import { MockShopify } from "../testing/mock-shopify.ts";
import { expandOrder, type Spec } from "../testing/order-fixtures.ts";

const SHOP = "harbour-pine-demo.myshopify.com";
const doc = JSON.parse(readFileSync(new URL("../fixtures/orders.json", import.meta.url), "utf8")) as { orders: Array<Record<string, unknown>> };
let mock: MockShopify;
const clock = { t: 9_000_000 };

beforeAll(async () => {
  mock = await new MockShopify({ orders: doc.orders, accessTokens: ["tok"], now: () => clock.t }).start();
});
afterAll(async () => {
  await mock.stop();
});

const client = () => new AdminClient({ shop: SHOP, accessToken: "tok", baseUrl: mock.baseUrl, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } });
const names = (orders: Order[]): string[] => orders.map((o) => o.name);

describe("buildOrdersQuery", () => {
  it("asks only for the money side that will be used", () => {
    expect(buildOrdersQuery("shop")).toContain("shopMoney");
    expect(buildOrdersQuery("shop")).not.toContain("presentmentMoney");
    expect(buildOrdersQuery("presentment")).toContain("presentmentMoney");
    expect(buildOrdersQuery("presentment")).not.toContain("shopMoney");
  });
  it("is deterministic, sorts by UPDATED_AT and takes first/after/query as variables", () => {
    const q = buildOrdersQuery();
    expect(q).toBe(buildOrdersQuery("shop", DEFAULT_NESTED_LIMITS));
    expect(q).toContain("query SalesOrders($first: Int!, $after: String, $query: String)");
    expect(q).toContain("sortKey: UPDATED_AT");
  });
  it("requests no personal data (no email, no customer, no addresses)", () => {
    const q = buildOrdersQuery("shop");
    for (const word of ["email", "customer", "address", "phone", "billing", "shipping_address"]) expect(q.toLowerCase()).not.toContain(word);
  });
  it("puts the nested limits into the query", () => {
    const q = buildOrdersQuery("shop", { ...DEFAULT_NESTED_LIMITS, lineItems: 37, refunds: 9 });
    expect(q).toContain("lineItems(first: 37)");
    expect(q).toContain("refunds(first: 9)");
  });
});

describe("buildOrdersSearch", () => {
  it("excludes test orders by default and filters on updated_at when given", () => {
    expect(buildOrdersSearch()).toBe("test:false");
    expect(buildOrdersSearch({ updatedSince: "2026-10-26T04:00:00Z" })).toBe("updated_at:>='2026-10-26T04:00:00Z' test:false");
    expect(buildOrdersSearch({ excludeTest: false })).toBeNull();
    expect(buildOrdersSearch({ excludeTest: false, updatedSince: "2026-10-26T04:00:00Z" })).toBe("updated_at:>='2026-10-26T04:00:00Z'");
  });
  it("rejects a value that is not a timestamp, or that tries to add search terms", () => {
    expect(() => buildOrdersSearch({ updatedSince: "yesterday" })).toThrow(/not a valid timestamp/);
    expect(() => buildOrdersSearch({ updatedSince: "2026-10-26T04:00:00Z' OR test:true" })).toThrow();
    expect(() => buildOrdersSearch({ updatedSince: "Oct 26 2026 '" })).toThrow();
  });
});

describe("fetchAllOrders against the mock Admin API", () => {
  it("returns every order exactly once, oldest update first, and skips test orders when asked", async () => {
    const orders = await fetchAllOrders(client(), { search: buildOrdersSearch() });
    expect(names(orders)).toEqual(["#1001", "#1002", "#1009", "#1006", "#1003", "#1007", "#1010", "#1008", "#1004"]);
    expect(new Set(orders.map((o) => o.id)).size).toBe(orders.length);
  });

  it("returns the test order too when not filtered (the aggregator, not the fetch, applies the policy)", async () => {
    const orders = await fetchAllOrders(client(), { search: null });
    expect(orders).toHaveLength(10);
    expect(orders.some((o) => o.test)).toBe(true);
  });

  it("filters on updated_at", async () => {
    const orders = await fetchAllOrders(client(), { search: buildOrdersSearch({ updatedSince: "2026-11-02T00:00:00Z" }) });
    expect(names(orders)).toEqual(["#1003", "#1007", "#1010", "#1008", "#1004"]);
  });

  it("pages with cursors: one order per page gives one request per order", async () => {
    const pages: number[] = [];
    const before = mock.graphqlRequests().length;
    const orders = await fetchAllOrders(client(), { search: null, pageSize: 1, onPage: (p) => pages.push(p.orders.length) });
    expect(orders).toHaveLength(10);
    expect(pages).toEqual(Array(10).fill(1));
    expect(mock.graphqlRequests().length - before).toBe(10);
  });

  it("pages through the same set whatever the page size", async () => {
    const a = await fetchAllOrders(client(), { search: null, pageSize: 1 });
    const b = await fetchAllOrders(client(), { search: null, pageSize: 3 });
    expect(names(a)).toEqual(names(b));
  });

  it("keeps the requested cost of the default page below the 1000-point single-query limit", async () => {
    const costs: number[] = [];
    await fetchAllOrders(client(), { onPage: (p) => costs.push(p.result.extensions.cost?.requestedQueryCost ?? -1) });
    expect(costs.length).toBeGreaterThan(0);
    for (const c of costs) expect(c).toBeLessThan(1000);
  });

  it("halves the page size when Shopify says the query is too expensive, and loses no order", async () => {
    const sizes: number[] = [];
    const before = mock.graphqlRequests().length;
    const orders = await fetchAllOrders(client(), { search: null, pageSize: 16, onPage: (p) => sizes.push(p.pageSize) });
    expect(orders).toHaveLength(10);
    expect(new Set(orders.map((o) => o.id)).size).toBe(10);
    expect(sizes[0]).toBeLessThan(16);
    expect(sizes.every((s) => s === sizes[0])).toBe(true); // it remembers the size that worked
    expect(mock.graphqlRequests().length - before).toBeGreaterThan(sizes.length); // at least one rejected attempt
  });

  it("asks for presentment amounts when asked, and the response then has no shopMoney", async () => {
    const orders = await fetchAllOrders(client(), { search: null, mode: "presentment" });
    const jpy = orders.find((o) => o.name === "#1007")!;
    expect(jpy.totalPriceSet.presentmentMoney).toEqual({ amount: "16109", currencyCode: "JPY" });
    expect(jpy.totalPriceSet.shopMoney).toBeUndefined();
  });

  it("fetches the shop's time zone and currency", async () => {
    expect(await fetchShopInfo(client())).toEqual({ name: "Harbour & Pine Goods", myshopifyDomain: SHOP, ianaTimezone: "America/Toronto", currencyCode: "CAD" });
  });
});

describe("truncated nested lists are an error, never silent data loss", () => {
  const spec = (over: Partial<Spec>): Spec => ({ number: 3001, processedAt: "2026-10-30T14:00:00Z", lines: [{ title: "a", qty: 1, unit: 100 }], discount: 0, shipping: [0], tax: 0, expectTotal: 100, ...over });
  const mockWith = async (order: Record<string, unknown>) => {
    const m = await new MockShopify({ orders: [order], accessTokens: ["tok"], now: () => clock.t }).start();
    const c = new AdminClient({ shop: SHOP, accessToken: "tok", baseUrl: m.baseUrl, now: () => clock.t, sleep: async () => {} });
    return { m, c };
  };

  it("more line items than the limit -> OrderShapeError naming lineItems", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ title: `l${i}`, qty: 1, unit: 100 }));
    const { m, c } = await mockWith(expandOrder(spec({ lines, expectTotal: 1200 })));
    try {
      await expect(fetchAllOrders(c)).rejects.toThrow(/more lineItems than the 10 requested/);
      const ok = await fetchAllOrders(c, { limits: { ...DEFAULT_NESTED_LIMITS, lineItems: 20 } });
      expect(ok[0]!.lineItems.nodes).toHaveLength(12);
    } finally {
      await m.stop();
    }
  });

  it("refunds reaching the requested limit -> OrderShapeError (a plain list has no pageInfo to tell)", async () => {
    const refunds = Array.from({ length: 3 }, (_, i) => ({ processedAt: `2026-11-0${i + 1}T14:00:00Z`, lines: [{ line: 0, qty: 1, subtotal: 10, tax: 0 }] }));
    const { m, c } = await mockWith(expandOrder(spec({ refunds })));
    try {
      await expect(fetchAllOrders(c)).rejects.toThrow(/reaches the requested limit of 3/);
      expect((await fetchAllOrders(c, { limits: { ...DEFAULT_NESTED_LIMITS, refunds: 4 } }))[0]!.refunds).toHaveLength(3);
    } finally {
      await m.stop();
    }
  });

  it("too many refund line items -> OrderShapeError naming the refund", async () => {
    const refunds = [{ processedAt: "2026-11-01T14:00:00Z", lines: Array.from({ length: 6 }, () => ({ line: 0, qty: 1, subtotal: 1, tax: 0 })) }];
    const { m, c } = await mockWith(expandOrder(spec({ refunds })));
    try {
      await expect(fetchAllOrders(c)).rejects.toThrow(/refundLineItems/);
    } finally {
      await m.stop();
    }
  });
});

describe("pagination guards (stubbed client)", () => {
  const minimal = (n: number): Record<string, unknown> => ({ id: `gid://shopify/Order/${n}`, processedAt: "2026-10-30T00:00:00Z", lineItems: { nodes: [] }, shippingLines: { nodes: [] }, refunds: [] });
  const stub = (pages: Array<{ orders: unknown; hasNextPage: boolean; endCursor?: string | null } | Error>): AdminClient => {
    let i = 0;
    return {
      graphql: async () => {
        const page = pages[Math.min(i++, pages.length - 1)]!;
        if (page instanceof Error) throw page;
        return { data: { orders: { nodes: page.orders, pageInfo: { hasNextPage: page.hasNextPage, endCursor: page.endCursor ?? null } } }, extensions: {}, apiVersion: null, attempts: 1, waitedMs: 0 };
      },
    } as unknown as AdminClient;
  };

  it("stops when a cursor repeats instead of looping forever", async () => {
    const c = stub([{ orders: [minimal(1)], hasNextPage: true, endCursor: "same" }]);
    await expect(fetchAllOrders(c)).rejects.toBeInstanceOf(PaginationError);
    await expect(fetchAllOrders(stub([{ orders: [minimal(1)], hasNextPage: true, endCursor: "same" }]))).rejects.toThrow(/returned twice/);
  });

  it("refuses hasNextPage without an endCursor", async () => {
    await expect(fetchAllOrders(stub([{ orders: [minimal(1)], hasNextPage: true, endCursor: null }]))).rejects.toThrow(/no endCursor/);
    await expect(fetchAllOrders(stub([{ orders: [minimal(1)], hasNextPage: true, endCursor: "" }]))).rejects.toThrow(/no endCursor/);
  });

  it("stops at maxPages", async () => {
    let n = 0;
    const c = { graphql: async () => ({ data: { orders: { nodes: [minimal(n)], pageInfo: { hasNextPage: true, endCursor: `c${n++}` } } }, extensions: {}, apiVersion: null, attempts: 1, waitedMs: 0 }) } as unknown as AdminClient;
    await expect(fetchAllOrders(c, { maxPages: 5 })).rejects.toThrow(/stopped after 5 pages/);
    expect(n).toBe(5);
  });

  it("stops at the documented 25,000-object pagination cap and says what to do", async () => {
    let page = 0;
    const c = {
      graphql: async () => {
        const nodes = Array.from({ length: MAX_PAGE_SIZE }, (_, i) => minimal(page * MAX_PAGE_SIZE + i));
        return { data: { orders: { nodes, pageInfo: { hasNextPage: true, endCursor: `c${page++}` } } }, extensions: {}, apiVersion: null, attempts: 1, waitedMs: 0 };
      },
    } as unknown as AdminClient;
    await expect(fetchAllOrders(c, { pageSize: MAX_PAGE_SIZE })).rejects.toThrow(/25,000-object pagination cap/);
    expect(page * MAX_PAGE_SIZE).toBe(PAGINATION_CAP);
  });

  it("rejects a response without data.orders.nodes", async () => {
    const c = { graphql: async () => ({ data: {}, extensions: {}, apiVersion: null, attempts: 1, waitedMs: 0 }) } as unknown as AdminClient;
    await expect(fetchAllOrders(c)).rejects.toBeInstanceOf(OrderShapeError);
  });

  it("rejects an order without id/processedAt", async () => {
    await expect(fetchAllOrders(stub([{ orders: [{ lineItems: { nodes: [] }, shippingLines: { nodes: [] }, refunds: [] }], hasNextPage: false }]))).rejects.toThrow(/no id or processedAt/);
  });

  it("rejects an order whose refunds or connections are missing", async () => {
    await expect(fetchAllOrders(stub([{ orders: [{ ...minimal(1), refunds: undefined }], hasNextPage: false }]))).rejects.toThrow(/refunds missing/);
    await expect(fetchAllOrders(stub([{ orders: [{ ...minimal(1), lineItems: undefined }], hasNextPage: false }]))).rejects.toThrow(/lineItems missing/);
  });

  it("cannot halve below one order per page: the error surfaces", async () => {
    await expect(fetchAllOrders(stub([new QueryCostError("too expensive")]), { pageSize: 1 })).rejects.toBeInstanceOf(QueryCostError);
  });

  it("rejects an unusable page size", async () => {
    for (const pageSize of [0, -1, 1.5, MAX_PAGE_SIZE + 1]) {
      await expect(fetchAllOrders(stub([{ orders: [], hasNextPage: false }]), { pageSize })).rejects.toThrow(/pageSize must be/);
    }
  });

  it("iterateOrders yields page by page", async () => {
    const seen: number[] = [];
    for await (const page of iterateOrders(stub([{ orders: [minimal(1), minimal(2)], hasNextPage: true, endCursor: "a" }, { orders: [minimal(3)], hasNextPage: false }]))) seen.push(page.length);
    expect(seen).toEqual([2, 1]);
  });
});

describe("fetchShopInfo errors", () => {
  it("rejects a shop answer without a time zone", async () => {
    const c = { graphql: async () => ({ data: { shop: { name: "x", currencyCode: "CAD" } }, extensions: {}, apiVersion: null, attempts: 1, waitedMs: 0 }) } as unknown as AdminClient;
    await expect(fetchShopInfo(c)).rejects.toBeInstanceOf(OrderShapeError);
  });
});
