import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AggregationError, aggregateSales, type AggregateOptions, type Metrics } from "../src/aggregate.ts";
import type { Order } from "../src/orders.ts";
import { SPECS, expandOrder, type Spec } from "../testing/order-fixtures.ts";

const fixtureOrders = (JSON.parse(readFileSync(new URL("../fixtures/orders.json", import.meta.url), "utf8")) as { orders: Order[] }).orders;
const byName = (name: string): Order => fixtureOrders.find((o) => o.name === name)!;
const TORONTO: AggregateOptions = { timeZone: "America/Toronto" };
const WINDOW: AggregateOptions = { timeZone: "America/Toronto", from: "2026-10-29", until: "2026-11-03" };

const spec = (over: Partial<Spec> = {}): Spec => ({ number: 4001, processedAt: "2026-10-30T14:00:00Z", lines: [{ title: "a", qty: 1, unit: 1000 }], discount: 0, shipping: [0], tax: 0, expectTotal: 1000, ...over });
const made = (over: Partial<Spec> = {}): Order => expandOrder(spec(over)) as unknown as Order;
const clone = (o: Order): Order => structuredClone(o);
const day = (r: ReturnType<typeof aggregateSales>, d: string, currency = "CAD") => r.rows.find((x) => x.day === d && x.currency === currency);
const codes = (r: ReturnType<typeof aggregateSales>): string[] => r.issues.map((i) => i.code);

describe("metrics for single orders", () => {
  it("a plain order: gross, discount, shipping, tax, total and one order", () => {
    const r = aggregateSales([byName("#1001")], TORONTO);
    expect(r.totals["CAD"]).toEqual({ orders: 1, gross_sales: 4850, discounts: 0, net_sales_reversals: 0, net_sales: 4850, shipping_charges: 800, shipping_reversals: 0, taxes: 735, tax_reversals: 0, other_refunds: 0, total_sales: 6385 });
  });

  it("discounts reduce net sales but not gross sales", () => {
    const m = aggregateSales([byName("#1003")], { ...TORONTO, until: "2026-10-31" }).totals["CAD"]!;
    expect(m.gross_sales).toBe(21000);
    expect(m.discounts).toBe(2100);
    expect(m.net_sales).toBe(18900);
  });

  it("a fully refunded order nets to exactly zero in every money metric, across two different days", () => {
    const r = aggregateSales([byName("#1004")], TORONTO);
    const t = r.totals["CAD"]!;
    expect(t).toMatchObject({ orders: 1, gross_sales: 1250, net_sales_reversals: 1250, net_sales: 0, shipping_charges: 800, shipping_reversals: 800, taxes: 267, tax_reversals: 267, total_sales: 0 });
    expect(r.rows.map((x) => [x.day, x.total_sales])).toEqual([["2026-10-31", 2317], ["2026-11-03", -2317]]);
  });

  it("a partial refund subtracts only what was refunded", () => {
    const t = aggregateSales([byName("#1003")], TORONTO).totals["CAD"]!;
    expect(t.net_sales_reversals).toBe(2700);
    expect(t.tax_reversals).toBe(351);
    expect(t.total_sales).toBe(21357 - 3051);
  });

  it("a shipping-only refund leaves net sales alone", () => {
    const t = aggregateSales([byName("#1008")], { ...TORONTO, currency: "shop" }).totals["CAD"]!;
    expect(t.net_sales).toBe(7250 - 725);
    expect(t.shipping_reversals).toBe(800);
    expect(t.tax_reversals).toBe(104);
    expect(t.total_sales).toBe(8277 - 904);
  });

  it("several refunds on one order are attributed to their own days", () => {
    const o = made({
      lines: [{ title: "a", qty: 4, unit: 1000 }],
      expectTotal: 4000,
      refunds: [
        { processedAt: "2026-10-31T14:00:00Z", lines: [{ line: 0, qty: 1, subtotal: 1000, tax: 0 }] },
        { processedAt: "2026-11-02T14:00:00Z", lines: [{ line: 0, qty: 2, subtotal: 2000, tax: 0 }] },
      ],
    });
    const r = aggregateSales([o], TORONTO);
    expect(r.rows.map((x) => [x.day, x.orders, x.net_sales_reversals])).toEqual([["2026-10-30", 1, 0], ["2026-10-31", 0, 1000], ["2026-11-02", 0, 2000]]);
    expect(r.totals["CAD"]!.net_sales).toBe(1000);
  });

  it("derivations hold on every row and total of the fixture (net_sales and total_sales formulas)", () => {
    const r = aggregateSales(fixtureOrders, { ...WINDOW, currency: "presentment" });
    const check = (m: Metrics): void => {
      expect(m.net_sales).toBe(m.gross_sales - m.discounts - m.net_sales_reversals);
      expect(m.total_sales).toBe(m.net_sales + (m.shipping_charges - m.shipping_reversals) + (m.taxes - m.tax_reversals) - m.other_refunds);
    };
    r.rows.forEach(check);
    Object.values(r.totals).forEach(check);
  });

  it("is exact over many small amounts (1000 orders of 0.10)", () => {
    const orders = Array.from({ length: 1000 }, (_, i) => made({ number: 5000 + i, lines: [{ title: "x", qty: 1, unit: 10 }], expectTotal: 10 }));
    expect(aggregateSales(orders, TORONTO).totals["CAD"]).toMatchObject({ orders: 1000, gross_sales: 10_000, total_sales: 10_000 });
  });

  it("handles an order with null discount and tax sets", () => {
    const o = clone(made());
    (o as { totalDiscountsSet: unknown }).totalDiscountsSet = null;
    (o as { totalTaxSet: unknown }).totalTaxSet = null;
    (o as { subtotalPriceSet: unknown }).subtotalPriceSet = null;
    expect(aggregateSales([o], TORONTO).totals["CAD"]!.total_sales).toBe(1000);
  });

  it("returns no rows and no totals for no orders", () => {
    const r = aggregateSales([], TORONTO);
    expect(r).toMatchObject({ rows: [], totals: {}, complete: true, counted: { orders: 0, refunds: 0 } });
  });
});

describe("what counts: test and cancelled orders", () => {
  it("excludes test and cancelled orders (and their refunds) by default, and says how many", () => {
    const r = aggregateSales(fixtureOrders, WINDOW);
    expect(r.excluded).toEqual({ test: 1, cancelled: 1, unsupported: 0, refundsNotCounted: 0 });
    expect(r.counted).toEqual({ orders: 7, refunds: 4 });
  });

  it("includes test orders when told to", () => {
    const base = aggregateSales(fixtureOrders, WINDOW).totals["CAD"]!;
    const withTest = aggregateSales(fixtureOrders, { ...WINDOW, excludeTest: false }).totals["CAD"]!;
    expect(withTest.orders).toBe(base.orders + 1);
    expect(withTest.total_sales - base.total_sales).toBe(14916);
  });

  it("includes cancelled orders when told to", () => {
    const base = aggregateSales(fixtureOrders, WINDOW).totals["CAD"]!;
    const withCancelled = aggregateSales(fixtureOrders, { ...WINDOW, excludeCancelled: false }).totals["CAD"]!;
    expect(withCancelled.total_sales - base.total_sales).toBe(9040);
  });

  it("a cancelled order with a refund drops the refund too", () => {
    const o = made({ cancelledAt: "2026-10-31T00:00:00Z", refunds: [{ processedAt: "2026-10-31T01:00:00Z", lines: [{ line: 0, qty: 1, subtotal: 1000, tax: 0 }] }] });
    expect(aggregateSales([o], TORONTO).rows).toEqual([]);
  });
});

describe("days: the shop's time zone, daylight saving included", () => {
  it("places an evening order on its local day, not its UTC day (#1002: 2026-10-31T03:30Z is Oct 30 in Toronto)", () => {
    const toronto = aggregateSales([byName("#1002")], TORONTO);
    const utc = aggregateSales([byName("#1002")], { timeZone: "UTC" });
    expect(toronto.rows[0]!.day).toBe("2026-10-30");
    expect(utc.rows[0]!.day).toBe("2026-10-31");
  });

  it("puts a refund at 2026-11-02T04:30Z on Nov 1 (23:30 EST), which a fixed UTC-4 offset or UTC would get wrong", () => {
    const refundDay = (tz: string): string => aggregateSales([byName("#1003")], { timeZone: tz }).rows.find((r) => r.net_sales_reversals > 0)!.day;
    expect(refundDay("America/Toronto")).toBe("2026-11-01");
    expect(refundDay("UTC")).toBe("2026-11-02");
    expect(refundDay("Etc/GMT+4")).toBe("2026-11-02"); // fixed UTC-4
  });

  it("an order at exactly local midnight belongs to the new day (#1007 at 2026-11-02T05:00Z)", () => {
    expect(aggregateSales([byName("#1007")], TORONTO).rows[0]!.day).toBe("2026-11-02");
  });

  it("grand totals do not depend on the time zone when the window covers everything", () => {
    const a = aggregateSales(fixtureOrders, TORONTO).totals;
    const b = aggregateSales(fixtureOrders, { timeZone: "UTC" }).totals;
    const c = aggregateSales(fixtureOrders, { timeZone: "Asia/Kolkata" }).totals;
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("dateField createdAt uses the creation time instead (#1007 was created 10 minutes before local midnight)", () => {
    expect(aggregateSales([byName("#1007")], { ...TORONTO, dateField: "createdAt" }).rows[0]!.day).toBe("2026-11-01");
    expect(aggregateSales([byName("#1007")], { ...TORONTO, dateField: "processedAt" }).rows[0]!.day).toBe("2026-11-02");
  });

  it("rejects an unknown time zone", () => {
    expect(() => aggregateSales([], { timeZone: "Nowhere/Land" })).toThrow(/unknown time zone/);
  });
});

describe("the reporting window", () => {
  it("keeps a refund inside the window even when its sale is before it (#1009: sold Oct 28, refunded Nov 1)", () => {
    const r = aggregateSales([byName("#1009")], WINDOW);
    expect(r.rows.map((x) => [x.day, x.orders, x.net_sales_reversals])).toEqual([["2026-11-01", 0, 12000]]);
    expect(r.totals["CAD"]!.total_sales).toBe(-13560);
  });

  it("drops events on days outside from/until, inclusive at both ends", () => {
    const r = aggregateSales(fixtureOrders, { ...TORONTO, from: "2026-10-31", until: "2026-11-01" });
    expect(r.rows.map((x) => x.day)).toEqual(["2026-10-31", "2026-11-01"]);
    expect(day(r, "2026-10-31")!.orders).toBe(2);
  });

  it("a window of a single day works", () => {
    const r = aggregateSales(fixtureOrders, { ...TORONTO, from: "2026-11-02", until: "2026-11-02" });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.orders).toBe(3);
  });

  it("rejects a malformed or reversed window", () => {
    expect(() => aggregateSales([], { ...TORONTO, from: "2026-11-1" })).toThrow(/from must be a YYYY-MM-DD/);
    expect(() => aggregateSales([], { ...TORONTO, until: "2026-02-30" })).toThrow(/until must be a YYYY-MM-DD/);
    expect(() => aggregateSales([], { ...TORONTO, from: "2026-11-02", until: "2026-11-01" })).toThrow(/from is after until/);
  });
});

describe("currencies", () => {
  it("shop mode reports everything in the shop currency (one currency bucket)", () => {
    const r = aggregateSales(fixtureOrders, { ...WINDOW, currency: "shop" });
    expect(Object.keys(r.totals)).toEqual(["CAD"]);
    expect(r.totals["CAD"]!.orders).toBe(7);
  });

  it("presentment mode keeps one bucket per customer currency, with zero-decimal yen untouched", () => {
    const r = aggregateSales(fixtureOrders, { ...WINDOW, currency: "presentment" });
    expect(Object.keys(r.totals).sort()).toEqual(["CAD", "GBP", "JPY", "USD"]);
    expect(r.totals["JPY"]).toMatchObject({ orders: 1, gross_sales: 12960, shipping_charges: 1296, taxes: 1853, total_sales: 16109 });
    expect(r.totals["USD"]!.total_sales).toBe(2685);
    expect(r.totals["GBP"]!.total_sales).toBe(4635 - 506);
  });

  it("a refund stays in the currency of its order", () => {
    const r = aggregateSales([byName("#1008")], { ...TORONTO, currency: "presentment" });
    expect(r.rows.map((x) => x.currency)).toEqual(["GBP", "GBP"]);
    expect(r.totals["GBP"]!.shipping_reversals).toBe(448);
  });

  it("rejects an amount in the wrong currency for the chosen mode", () => {
    const o = clone(byName("#1001"));
    o.totalPriceSet.shopMoney!.currencyCode = "USD";
    const r = aggregateSales([o], { ...TORONTO, strict: false });
    expect(codes(r)).toContain("CURRENCY_MISMATCH");
  });
});

describe("orders that cannot be aggregated safely", () => {
  it("strict mode (the default) throws AggregationError listing the orders", () => {
    const o = clone(made());
    o.taxesIncluded = true;
    expect(() => aggregateSales([o], TORONTO)).toThrow(AggregationError);
    try {
      aggregateSales([o], TORONTO);
    } catch (error) {
      expect((error as AggregationError).issues[0]).toMatchObject({ code: "TAX_INCLUDED_UNSUPPORTED", severity: "error" });
      expect((error as Error).message).toContain("TAX_INCLUDED_UNSUPPORTED");
    }
  });

  it("non-strict mode leaves the order out, reports it, and marks the result incomplete", () => {
    const bad = clone(made({ number: 1 }));
    bad.taxesIncluded = true;
    const r = aggregateSales([bad, made({ number: 2 })], { ...TORONTO, strict: false });
    expect(r.complete).toBe(false);
    expect(r.excluded.unsupported).toBe(1);
    expect(r.totals["CAD"]!.orders).toBe(1);
  });

  it("taxes-included orders are refused, not guessed", () => {
    const o = clone(made());
    o.taxesIncluded = true;
    expect(codes(aggregateSales([o], { ...TORONTO, strict: false }))).toEqual(["TAX_INCLUDED_UNSUPPORTED"]);
  });

  it("gift card lines are refused", () => {
    const o = clone(made());
    o.lineItems.nodes[0]!.isGiftCard = true;
    expect(codes(aggregateSales([o], { ...TORONTO, strict: false }))).toEqual(["GIFT_CARD_UNSUPPORTED"]);
  });

  it("a missing money bag is MISSING_MONEY, and a bag without the requested side too", () => {
    const a = clone(made());
    (a as { totalPriceSet: unknown }).totalPriceSet = null;
    expect(codes(aggregateSales([a], { ...TORONTO, strict: false }))).toContain("MISSING_MONEY");
    const b = clone(made());
    delete b.totalPriceSet.shopMoney;
    expect(codes(aggregateSales([b], { ...TORONTO, strict: false }))).toContain("MISSING_MONEY");
  });

  it("an order whose line items do not add up to its subtotal is SUBTOTAL_MISMATCH", () => {
    const o = clone(made());
    o.subtotalPriceSet!.shopMoney!.amount = "9.99";
    expect(codes(aggregateSales([o], { ...TORONTO, strict: false }))).toContain("SUBTOTAL_MISMATCH");
  });

  it("an order whose total contains something the kit does not model (a tip, a fee) is TOTAL_MISMATCH", () => {
    const o = clone(made());
    o.totalPriceSet.shopMoney!.amount = "11.00";
    expect(codes(aggregateSales([o], { ...TORONTO, strict: false }))).toContain("TOTAL_MISMATCH");
  });

  it("a malformed amount is BAD_AMOUNT (more decimals than the currency allows, or text)", () => {
    const a = clone(made());
    a.lineItems.nodes[0]!.originalTotalSet.shopMoney!.amount = "10.005";
    expect(codes(aggregateSales([a], { ...TORONTO, strict: false }))).toContain("BAD_AMOUNT");
    const b = clone(made());
    b.totalTaxSet!.shopMoney!.amount = "twelve";
    expect(codes(aggregateSales([b], { ...TORONTO, strict: false }))).toContain("BAD_AMOUNT");
  });

  it("an unknown currency code is BAD_AMOUNT, never assumed to have two decimals", () => {
    const o = clone(made());
    o.currencyCode = "ZZZ";
    expect(codes(aggregateSales([o], { ...TORONTO, strict: false }))).toContain("BAD_AMOUNT");
  });

  it("a refund whose total is not explained by its parts is REFUND_TOTAL_MISMATCH", () => {
    const o = clone(made({ refunds: [{ processedAt: "2026-10-31T14:00:00Z", lines: [{ line: 0, qty: 1, subtotal: 1000, tax: 0 }] }] }));
    o.refunds[0]!.totalRefundedSet.shopMoney!.amount = "12.00";
    expect(codes(aggregateSales([o], { ...TORONTO, strict: false }))).toContain("REFUND_TOTAL_MISMATCH");
  });

  it("an unreadable date is an error that names it", () => {
    const o = clone(made());
    o.processedAt = "yesterday";
    expect(() => aggregateSales([o], TORONTO)).toThrow(/not a valid timestamp/);
  });
});

describe("warnings do not stop the run", () => {
  const withRefund = (): Order => clone(made({ refunds: [{ processedAt: "2026-10-31T14:00:00Z", lines: [{ line: 0, qty: 1, subtotal: 1000, tax: 0 }] }] }));

  it("an order adjustment is reported as other_refunds (REFUND_ADJUSTMENT)", () => {
    const o = withRefund();
    o.refunds[0]!.totalRefundedSet.shopMoney!.amount = "15.00";
    o.refunds[0]!.orderAdjustments.nodes.push({ amountSet: { shopMoney: { amount: "-5.00", currencyCode: "CAD" } }, taxAmountSet: { shopMoney: { amount: "0.00", currencyCode: "CAD" } }, reason: "OTHER" });
    const r = aggregateSales([o], TORONTO);
    expect(codes(r)).toContain("REFUND_ADJUSTMENT");
    expect(r.totals["CAD"]!.other_refunds).toBe(500);
    expect(r.totals["CAD"]!.total_sales).toBe(1000 - 1000 - 500);
    expect(r.complete).toBe(true);
  });

  it("a refund with only PENDING transactions is counted, with a REFUND_PENDING warning", () => {
    const o = withRefund();
    o.refunds[0]!.transactions.nodes[0]!.status = "PENDING";
    const r = aggregateSales([o], TORONTO);
    expect(codes(r)).toContain("REFUND_PENDING");
    expect(r.totals["CAD"]!.net_sales_reversals).toBe(1000);
  });

  it("a refund whose transactions all failed moved no money and is not counted", () => {
    const o = withRefund();
    o.refunds[0]!.transactions.nodes[0]!.status = "FAILURE";
    const r = aggregateSales([o], TORONTO);
    expect(codes(r)).toContain("REFUND_FAILED_TRANSACTIONS");
    expect(r.excluded.refundsNotCounted).toBe(1);
    expect(r.totals["CAD"]!.net_sales_reversals).toBe(0);
  });

  it("a refund with no transactions at all is counted (nothing contradicts it)", () => {
    const o = withRefund();
    o.refunds[0]!.transactions.nodes = [];
    expect(aggregateSales([o], TORONTO).totals["CAD"]!.net_sales_reversals).toBe(1000);
  });

  it("a current total that disagrees with total minus itemised refunds is only a warning", () => {
    const o = withRefund();
    o.currentTotalPriceSet.shopMoney!.amount = "3.21";
    const r = aggregateSales([o], TORONTO);
    expect(codes(r)).toContain("CURRENT_TOTAL_DIFFERS");
    expect(r.complete).toBe(true);
  });

  it("the shipped fixture produces no warnings at all", () => {
    expect(aggregateSales(fixtureOrders, WINDOW).issues).toEqual([]);
  });
});

describe("fixture specs", () => {
  it("every spec's hand-worked total matches its parts (expandOrder refuses otherwise)", () => {
    for (const s of SPECS) expect(() => expandOrder(s)).not.toThrow();
    expect(() => expandOrder({ ...SPECS[0]!, expectTotal: SPECS[0]!.expectTotal + 1 })).toThrow(/hand-worked total/);
  });
});
