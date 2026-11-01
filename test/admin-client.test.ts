import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminClient, AuthError, DEFAULT_API_VERSION, PartialResponseError, QueryCostError, ThrottledError, VersionMismatchError, isValidApiVersion, type AdminClientOptions } from "../src/admin-client.ts";
import { MockShopify } from "../testing/mock-shopify.ts";

const SHOP = "harbour-pine-demo.myshopify.com";
const Q = "query { shop { name } }";

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A fetch that plays back scripted responses (Response, or an Error to throw) and records requests. */
function scripted(script: Array<Response | Error>) {
  const requests: Recorded[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    requests.push({ url: String(url), init: init as RequestInit });
    const next = script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

const ok = (data: unknown = { shop: { name: "x" } }, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response => Response.json({ data, ...extra }, { headers });
const gqlError = (code: string, extra: Record<string, unknown> = {}): Response => Response.json({ errors: [{ message: code, extensions: { code } }], ...extra });
const cost = (requested: number, available: number, rate = 50, max = 1000) => ({ extensions: { cost: { requestedQueryCost: requested, actualQueryCost: null, throttleStatus: { maximumAvailable: max, currentlyAvailable: available, restoreRate: rate } } } });

function client(script: Array<Response | Error>, over: Partial<AdminClientOptions> = {}) {
  const s = scripted(script);
  const clock = { t: 1_000_000 };
  const slept: number[] = [];
  const c = new AdminClient({
    shop: SHOP,
    accessToken: "shpat_test",
    fetch: s.fetchFn,
    now: () => clock.t,
    sleep: async (ms) => { slept.push(ms); clock.t += ms; },
    random: () => 0.5,
    ...over,
  });
  return { c, clock, slept, requests: s.requests };
}

describe("construction", () => {
  it("pins 2026-10 by default and builds the versioned endpoint", () => {
    expect(DEFAULT_API_VERSION).toBe("2026-10");
    expect(new AdminClient({ shop: SHOP, accessToken: "t" }).endpoint).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
  });
  it("uses a configured version", () => {
    expect(new AdminClient({ shop: SHOP, accessToken: "t", apiVersion: "2026-04" }).endpoint).toContain("/admin/api/2026-04/");
    expect(new AdminClient({ shop: SHOP, accessToken: "t", apiVersion: "unstable" }).apiVersion).toBe("unstable");
  });
  it.each(["latest", "2026", "2026-02", "2026-10-01", "", "2026-13"])("rejects API version %j (never sends 'latest' or a made-up quarter)", (apiVersion) => {
    expect(() => new AdminClient({ shop: SHOP, accessToken: "t", apiVersion })).toThrow(/invalid API version/);
    expect(isValidApiVersion(apiVersion)).toBe(false);
  });
  it("accepts every quarter", () => {
    for (const v of ["2026-01", "2026-04", "2026-07", "2026-10", "2027-01"]) expect(isValidApiVersion(v)).toBe(true);
  });
  it("rejects an invalid shop or an empty token", () => {
    expect(() => new AdminClient({ shop: "evil.example", accessToken: "t" })).toThrow(/invalid shop domain/);
    expect(() => new AdminClient({ shop: SHOP, accessToken: "" })).toThrow(/accessToken/);
  });
  it("lower-cases the shop and trims trailing slashes from baseUrl", () => {
    const c = new AdminClient({ shop: "Harbour-Pine-Demo.myshopify.com", accessToken: "t", baseUrl: "http://127.0.0.1:4770//" });
    expect(c.shop).toBe(SHOP);
    expect(c.endpoint).toBe("http://127.0.0.1:4770/admin/api/2026-10/graphql.json");
  });
});

describe("request and response", () => {
  it("POSTs JSON with the access token header and returns data, extensions, answering version and attempts", async () => {
    const { c, requests } = client([ok({ shop: { name: "Harbour" } }, cost(1, 999, 100), { "x-shopify-api-version": "2026-10" })]);
    const r = await c.graphql<{ shop: { name: string } }>("query Shop($x: Int) { shop { name } }", { x: 1 }, { operationName: "Shop" });
    expect(r.data.shop.name).toBe("Harbour");
    expect(r.apiVersion).toBe("2026-10");
    expect(r.attempts).toBe(1);
    expect(r.waitedMs).toBe(0);
    expect(r.extensions.cost?.requestedQueryCost).toBe(1);
    const req = requests[0]!;
    expect(req.url).toBe(`https://${SHOP}/admin/api/2026-10/graphql.json`);
    expect(req.init.method).toBe("POST");
    const headers = req.init.headers as Record<string, string>;
    expect(headers["x-shopify-access-token"]).toBe("shpat_test");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(req.init.body))).toEqual({ query: "query Shop($x: Int) { shop { name } }", variables: { x: 1 }, operationName: "Shop" });
  });

  it("omits operationName when not given", async () => {
    const { c, requests } = client([ok()]);
    await c.graphql(Q);
    expect(Object.keys(JSON.parse(String(requests[0]!.init.body)))).toEqual(["query", "variables"]);
  });

  it("reports a missing version header as null", async () => {
    const { c } = client([ok()]);
    expect((await c.graphql(Q)).apiVersion).toBeNull();
  });
});

describe("THROTTLED", () => {
  it("waits until the bucket can hold the requested cost, using the throttleStatus Shopify returned", async () => {
    // needs 600, has 100, refills 50/s -> 10 s
    const { c, slept, requests } = client([gqlError("THROTTLED", cost(600, 100, 50)), ok()]);
    const r = await c.graphql(Q);
    expect(slept).toEqual([10_000]);
    expect(requests).toHaveLength(2);
    expect(r.attempts).toBe(2);
    expect(r.waitedMs).toBe(10_000);
  });

  it("never waits less than the recommended one second", async () => {
    const { c, slept } = client([gqlError("THROTTLED", cost(600, 590, 100)), ok()]);
    await c.graphql(Q);
    expect(slept).toEqual([1000]);
  });

  it("caps a very long refill estimate at maxBackoffMs, for the throttle wait and for the pacing wait alike", async () => {
    const { c, slept } = client([gqlError("THROTTLED", cost(1000, 0, 1)), ok()]);
    await c.graphql(Q);
    expect(slept[0]).toBe(30_000);
    expect(Math.max(...slept)).toBeLessThanOrEqual(30_000);
  });

  it("falls back to exponential backoff when the response carries no cost info", async () => {
    const { c, slept } = client([gqlError("THROTTLED"), gqlError("THROTTLED"), gqlError("THROTTLED"), ok()]);
    await c.graphql(Q);
    expect(slept).toEqual([1000, 2000, 4000]);
  });

  it("gives up with ThrottledError after maxRetries retries", async () => {
    const { c, requests } = client([gqlError("THROTTLED"), gqlError("THROTTLED"), gqlError("THROTTLED")], { maxRetries: 2 });
    await expect(c.graphql(Q)).rejects.toBeInstanceOf(ThrottledError);
    expect(requests).toHaveLength(3);
  });
});

describe("errors that must not be retried", () => {
  it("MAX_COST_EXCEEDED -> QueryCostError after one request", async () => {
    const { c, requests } = client([gqlError("MAX_COST_EXCEEDED")]);
    await expect(c.graphql(Q)).rejects.toBeInstanceOf(QueryCostError);
    expect(requests).toHaveLength(1);
  });
  it("ACCESS_DENIED -> AuthError", async () => {
    const { c, requests } = client([gqlError("ACCESS_DENIED")]);
    await expect(c.graphql(Q)).rejects.toBeInstanceOf(AuthError);
    expect(requests).toHaveLength(1);
  });
  it("HTTP 401 -> AuthError", async () => {
    const { c, requests } = client([new Response("nope", { status: 401 })]);
    await expect(c.graphql(Q)).rejects.toMatchObject({ name: "AuthError", status: 401 });
    expect(requests).toHaveLength(1);
  });
  it.each([402, 403, 404, 423])("HTTP %i -> ShopifyApiError without retrying", async (status) => {
    const { c, requests } = client([new Response("x", { status })]);
    await expect(c.graphql(Q)).rejects.toMatchObject({ name: "ShopifyApiError", status });
    expect(requests).toHaveLength(1);
  });
  it("SHOP_INACTIVE -> ShopifyApiError", async () => {
    const { c, requests } = client([gqlError("SHOP_INACTIVE")]);
    await expect(c.graphql(Q)).rejects.toMatchObject({ code: "SHOP_INACTIVE" });
    expect(requests).toHaveLength(1);
  });
  it("an unknown GraphQL error with no data is a ShopifyApiError carrying the messages", async () => {
    const { c } = client([Response.json({ errors: [{ message: "Field 'nope' doesn't exist on type 'Shop'" }] })]);
    await expect(c.graphql(Q)).rejects.toThrow(/Field 'nope' doesn't exist/);
  });
  it("a 200 with neither data nor errors is an error", async () => {
    const { c } = client([Response.json({})]);
    await expect(c.graphql(Q)).rejects.toThrow(/neither data nor errors/);
  });
  it("any other unexpected status (a 3xx) is an error", async () => {
    const { c } = client([new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } })]);
    await expect(c.graphql(Q)).rejects.toMatchObject({ status: 302 });
  });
});

describe("retried failures", () => {
  it.each([500, 502, 503, 504])("retries HTTP %i with backoff and then succeeds", async (status) => {
    const { c, slept } = client([new Response("x", { status }), ok()]);
    const r = await c.graphql(Q);
    expect(r.attempts).toBe(2);
    expect(slept).toEqual([1000]);
  });

  it("honours Retry-After on HTTP 429 when it is longer than the computed backoff", async () => {
    const { c, slept } = client([new Response("slow down", { status: 429, headers: { "retry-after": "7" } }), ok()]);
    await c.graphql(Q);
    expect(slept).toEqual([7000]);
  });

  it("ignores a Retry-After that is not a number", async () => {
    const { c, slept } = client([new Response("x", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }), ok()]);
    await c.graphql(Q);
    expect(slept).toEqual([1000]);
  });

  it("retries network errors and gives up with a ShopifyApiError that names the cause", async () => {
    const { c, requests } = client([new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")], { maxRetries: 2 });
    await expect(c.graphql(Q)).rejects.toThrow(/network error.*ECONNRESET/);
    expect(requests).toHaveLength(3);
  });

  it("retries a body that is not JSON", async () => {
    const { c } = client([new Response("<html>bad gateway</html>", { status: 200 }), ok()]);
    expect((await c.graphql(Q)).attempts).toBe(2);
  });

  it("retries INTERNAL_SERVER_ERROR", async () => {
    const { c } = client([gqlError("INTERNAL_SERVER_ERROR"), ok()]);
    expect((await c.graphql(Q)).attempts).toBe(2);
  });

  it("persistent 5xx ends in a ShopifyApiError with the status", async () => {
    const { c } = client([new Response("x", { status: 503 }), new Response("x", { status: 503 })], { maxRetries: 1 });
    await expect(c.graphql(Q)).rejects.toMatchObject({ name: "ShopifyApiError", status: 503 });
  });

  it("jitter stays within +-20% of the exponential step, never below the minimum, never above the maximum", async () => {
    for (const [random, attempt0, attempt1] of [[0, 1000, 1600], [1, 1200, 2400]] as const) {
      const { c, slept } = client([new Response("x", { status: 500 }), new Response("x", { status: 500 }), ok()], { random: () => random });
      await c.graphql(Q);
      expect(slept).toEqual([attempt0, attempt1]);
    }
    const { c, slept } = client([...Array.from({ length: 8 }, () => new Response("x", { status: 500 })), ok()], { random: () => 1, maxRetries: 8, maxBackoffMs: 5000 });
    await c.graphql(Q);
    expect(Math.max(...slept)).toBe(5000);
  });
});

describe("partial results", () => {
  const partial = (): Response => Response.json({ data: { shop: { name: "x" } }, errors: [{ message: "one order failed to resolve", path: ["orders", "nodes", 3] }] });
  it("throws PartialResponseError by default so a dashboard cannot silently drop rows", async () => {
    const { c } = client([partial()]);
    const error = await c.graphql(Q).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialResponseError);
    expect((error as PartialResponseError).data).toEqual({ shop: { name: "x" } });
    expect((error as PartialResponseError).errors?.[0]?.message).toContain("one order failed");
  });
  it("returns the data when the caller opts in", async () => {
    const { c } = client([partial()]);
    expect((await c.graphql(Q, {}, { allowPartial: true })).data).toEqual({ shop: { name: "x" } });
  });
});

describe("API version handling", () => {
  it("reports the version Shopify answered with, and throws VersionMismatchError in strict mode", async () => {
    const lax = client([ok({ a: 1 }, {}, { "x-shopify-api-version": "2026-01" })], { apiVersion: "2025-10" });
    expect((await lax.c.graphql(Q)).apiVersion).toBe("2026-01");
    const strict = client([ok({ a: 1 }, {}, { "x-shopify-api-version": "2026-01" })], { apiVersion: "2025-10", strictVersion: true });
    await expect(strict.c.graphql(Q)).rejects.toBeInstanceOf(VersionMismatchError);
  });
  it("strict mode accepts an answer for the pinned version", async () => {
    const { c } = client([ok({ a: 1 }, {}, { "x-shopify-api-version": "2026-10" })], { strictVersion: true });
    expect((await c.graphql(Q)).data).toEqual({ a: 1 });
  });
});

describe("cost-aware pacing", () => {
  it("knows nothing before the first response", () => {
    const { c } = client([]);
    expect(c.estimatedAvailable()).toBeNull();
  });

  it("projects the bucket forward with the restore rate, up to the maximum", async () => {
    const { c, clock } = client([ok({ a: 1 }, cost(100, 400, 50, 1000))]);
    await c.graphql(Q);
    expect(c.estimatedAvailable()).toBe(400);
    clock.t += 4000;
    expect(c.estimatedAvailable()).toBe(600);
    clock.t += 60_000;
    expect(c.estimatedAvailable()).toBe(1000);
  });

  it("waits BEFORE a repeat of an expensive query when the bucket is too low, then does not wait again", async () => {
    // first call: query costs 500, afterwards 100 points left, refill 100/s -> second call must wait 4 s
    const { c, slept, requests } = client([ok({ a: 1 }, cost(500, 100, 100)), ok({ a: 2 }, cost(500, 900, 100)), ok({ a: 3 }, cost(500, 900, 100))]);
    await c.graphql(Q);
    expect(slept).toEqual([]);
    const second = await c.graphql(Q);
    expect(slept).toEqual([4000]);
    expect(second.waitedMs).toBe(4000);
    await c.graphql(Q); // bucket reported 900 after the second call: no wait
    expect(slept).toEqual([4000]);
    expect(requests).toHaveLength(3);
  });

  it("waits only for the shortfall when time has already passed", async () => {
    const { c, clock, slept } = client([ok({ a: 1 }, cost(500, 100, 100)), ok({ a: 2 })]);
    await c.graphql(Q);
    clock.t += 3000; // 100 + 300 = 400 available, 100 short -> 1 s
    await c.graphql(Q);
    expect(slept).toEqual([1000]);
  });

  it("does not wait for a query shape it has never seen, unless told what to assume", async () => {
    const first = client([ok({ a: 1 }, cost(500, 10, 100)), ok({ a: 2 })]);
    await first.c.graphql(Q);
    await first.c.graphql("query { other }");
    expect(first.slept).toEqual([]);
    const assumed = client([ok({ a: 1 }, cost(500, 10, 100)), ok({ a: 2 })], { assumedCost: 300 });
    await assumed.c.graphql(Q);
    await assumed.c.graphql("query { other }");
    expect(assumed.slept).toEqual([2900]);
  });

  it("does not wait forever on a bucket that reports a restore rate of 0", async () => {
    const { c, slept } = client([ok({ a: 1 }, cost(500, 0, 0)), ok({ a: 2 })]);
    await c.graphql(Q);
    await c.graphql(Q);
    expect(slept).toEqual([]);
  });

  it("ignores throttleStatus values that are not numbers", async () => {
    const { c } = client([Response.json({ data: { a: 1 }, extensions: { cost: { requestedQueryCost: 5, throttleStatus: { maximumAvailable: "x", currentlyAvailable: null, restoreRate: 1 } } } })]);
    await c.graphql(Q);
    expect(c.estimatedAvailable()).toBeNull();
  });
});

describe("against the local mock Admin API", () => {
  let mock: MockShopify;
  const clock = { t: 5_000_000 };
  beforeAll(async () => {
    mock = await new MockShopify({ accessTokens: ["shpat_ok"], now: () => clock.t, bucket: { maximumAvailable: 52, restoreRate: 10 }, orders: [{ id: "gid://shopify/Order/1", name: "#1", processedAt: "2026-10-30T14:00:00Z", updatedAt: "2026-10-30T14:00:00Z", createdAt: "2026-10-30T14:00:00Z" }] }).start();
  });
  afterAll(async () => {
    await mock.stop();
  });
  const live = (over: Partial<AdminClientOptions> = {}) => {
    const slept: number[] = [];
    const c = new AdminClient({ shop: SHOP, accessToken: "shpat_ok", baseUrl: mock.baseUrl, now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms; }, ...over });
    return { c, slept };
  };

  it("answers the shop query and sends the pinned version in the path", async () => {
    const { c } = live({ apiVersion: "2026-07" });
    const r = await c.graphql<{ shop: { ianaTimezone: string } }>("query { shop { ianaTimezone currencyCode } }");
    expect(r.data.shop.ianaTimezone).toBe("America/Toronto");
    expect(mock.graphqlRequests().at(-1)!.path).toBe("/admin/api/2026-07/graphql.json");
    expect(r.apiVersion).toBe("2026-07");
  });

  it("rejects a wrong token with an AuthError", async () => {
    const { c } = live({ accessToken: "shpat_wrong" });
    await expect(c.graphql("query { shop { name } }")).rejects.toBeInstanceOf(AuthError);
  });

  it("falls forward when the pinned version is no longer served, and strict mode notices", async () => {
    const lax = live({ apiVersion: "2024-01" });
    expect((await lax.c.graphql("query { shop { name } }")).apiVersion).toBe("2026-01");
    const strict = live({ apiVersion: "2024-01", strictVersion: true });
    await expect(strict.c.graphql("query { shop { name } }")).rejects.toBeInstanceOf(VersionMismatchError);
  });

  it("surfaces the mock's validation error for a field that does not exist (an invented field name fails the test)", async () => {
    const { c } = live();
    await expect(c.graphql("query { shop { name notARealField } }")).rejects.toThrow(/doesn't exist on type 'Shop'/);
  });

  it.each([
    ["INTERNAL_SERVER_ERROR in a 200", { kind: "internal-error", times: 1 }],
    ["a dropped connection", { kind: "drop", times: 1 }],
    ["a body that is not JSON", { kind: "bad-json", times: 1 }],
    ["HTTP 503", { kind: "status", times: 1, status: 503 }],
  ] as const)("recovers from %s", async (_name, fault) => {
    const { c, slept } = live();
    mock.inject({ ...fault });
    const r = await c.graphql<{ shop: { name: string } }>("query { shop { name } }");
    expect(r.data.shop.name).toBe("Harbour & Pine Goods");
    expect(r.attempts).toBe(2);
    expect(slept.length).toBe(1);
  });

  it("honours a Retry-After header sent by the server", async () => {
    const { c, slept } = live();
    mock.inject({ kind: "status", times: 1, status: 429, headers: { "retry-after": "3" } });
    await c.graphql("query { shop { name } }");
    expect(slept).toEqual([3000]);
  });

  it("a THROTTLED answer from the mock carries throttleStatus, and the retry waits for it", async () => {
    const { c, slept } = live();
    mock.inject({ kind: "throttle", times: 1 });
    const r = await c.graphql("query { shop { name } }");
    expect(r.attempts).toBe(2);
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
  });

  it("the mock's leaky bucket throttles a second expensive query, and the pacing client waits instead of failing", async () => {
    clock.t += 60_000; // refill completely
    const q = "query { orders(first: 50) { nodes { id } } }";
    const a = live();
    const first = await a.c.graphql(q);
    expect(first.extensions.cost?.requestedQueryCost).toBe(51);
    // a fresh client knows nothing about the bucket: it gets THROTTLED and waits what the response says
    const naive = live();
    const second = await naive.c.graphql(q);
    expect(second.attempts).toBe(2);
    // the client that watched the bucket paces itself and is not throttled at all
    clock.t += 60_000;
    await a.c.graphql(q);
    const third = await a.c.graphql(q);
    expect(third.attempts).toBe(1);
    expect(third.waitedMs).toBeGreaterThan(0);
  });

  it("a partial response from the mock is refused by default", async () => {
    const { c } = live();
    clock.t += 60_000;
    mock.inject({ kind: "partial", times: 1 });
    await expect(c.graphql("query { orders(first: 1) { nodes { id } } }")).rejects.toBeInstanceOf(PartialResponseError);
  });

  it("MAX_COST_EXCEEDED from the mock is not retried", async () => {
    const { c } = live();
    await expect(c.graphql("query { orders(first: 250) { nodes { id name lineItems(first: 100) { nodes { id } } } } }")).rejects.toBeInstanceOf(QueryCostError);
  });
});

describe("source hygiene", () => {
  it("never sends the access token anywhere but a header (not in the URL, not in the body)", async () => {
    const { c, requests } = client([ok()]);
    await c.graphql(Q);
    expect(requests[0]!.url).not.toContain("shpat_test");
    expect(String(requests[0]!.init.body)).not.toContain("shpat_test");
    expect(readFileSync(new URL("../src/admin-client.ts", import.meta.url), "utf8")).not.toMatch(/console\.(log|error|warn)/);
  });
});
