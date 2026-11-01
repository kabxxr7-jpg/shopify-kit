// Order fixtures for the dashboard, written as compact specs and expanded into the GraphQL shape the Admin API
// returns (MoneyBag with shopMoney and presentmentMoney everywhere).
//
// EVERYTHING HERE IS FICTIONAL. Shop: "Harbour & Pine Goods", shop currency CAD, time zone America/Toronto.
// Amounts are integer cents (yen for JPY). Presentment amounts for foreign-currency orders are the shop amounts
// converted at a stated fixed rate and rounded half-up component by component; real Shopify fixes the rate at
// checkout, so only the pattern (two currencies on one order) is realistic, not the numbers.
//
// Each spec carries `expectTotal`, a total worked out by hand, and the expander refuses to run if its own sum
// disagrees: a typo in a spec cannot silently become "the right answer".
import { currencyExponent, formatMinor } from "../src/money.ts";

export const SHOP = { name: "Harbour & Pine Goods", myshopifyDomain: "harbour-pine-demo.myshopify.com", ianaTimezone: "America/Toronto", currencyCode: "CAD" } as const;

interface Line {
  title: string;
  qty: number;
  /** price of ONE unit, cents */
  unit: number;
}
interface RefundLine {
  /** index into `lines` */
  line: number;
  qty: number;
  /** refunded item value after discounts, cents */
  subtotal: number;
  tax: number;
}
interface Refund {
  processedAt: string;
  lines?: RefundLine[];
  shipping?: Array<{ subtotal: number; tax: number }>;
  /** status of the single refund transaction; default SUCCESS */
  status?: string;
}
export interface Spec {
  number: number;
  processedAt: string;
  createdAt?: string;
  test?: boolean;
  cancelledAt?: string;
  /** Presentment currency and the fixed rate [numerator, denominator] (1 CAD = num/den units). Default: CAD. */
  presentment?: { currency: string; rate: [number, number] };
  lines: Line[];
  discount: number;
  /** price of each shipping line after shipping discounts, cents */
  shipping: number[];
  tax: number;
  /** total worked out by hand: sum(lines) - discount + sum(shipping) + tax */
  expectTotal: number;
  refunds?: Refund[];
}

export const SPECS: Spec[] = [
  { number: 1001, processedAt: "2026-10-30T14:00:00Z", lines: [{ title: "Harbour mug", qty: 2, unit: 1800 }, { title: "Tea tin", qty: 1, unit: 1250 }], discount: 0, shipping: [800], tax: 735, expectTotal: 6385 },
  { number: 1002, processedAt: "2026-10-31T03:30:00Z", createdAt: "2026-10-31T03:24:00Z", presentment: { currency: "USD", rate: [72, 100] }, lines: [{ title: "Pine candle", qty: 1, unit: 3000 }], discount: 300, shipping: [600], tax: 429, expectTotal: 3729 },
  {
    number: 1003,
    processedAt: "2026-10-31T15:00:00Z",
    lines: [{ title: "Pine candle", qty: 3, unit: 3000 }, { title: "Wool throw", qty: 1, unit: 12000 }],
    discount: 2100,
    shipping: [0],
    tax: 2457,
    expectTotal: 21357,
    refunds: [{ processedAt: "2026-11-02T04:30:00Z", lines: [{ line: 0, qty: 1, subtotal: 2700, tax: 351 }] }],
  },
  {
    number: 1004,
    processedAt: "2026-11-01T03:59:00Z",
    lines: [{ title: "Tea tin", qty: 1, unit: 1250 }],
    discount: 0,
    shipping: [800],
    tax: 267,
    expectTotal: 2317,
    refunds: [{ processedAt: "2026-11-03T15:00:00Z", lines: [{ line: 0, qty: 1, subtotal: 1250, tax: 163 }], shipping: [{ subtotal: 800, tax: 104 }] }],
  },
  { number: 1005, processedAt: "2026-11-01T15:00:00Z", test: true, lines: [{ title: "Wool throw", qty: 1, unit: 12000 }], discount: 0, shipping: [1200], tax: 1716, expectTotal: 14916 },
  { number: 1006, processedAt: "2026-11-01T16:00:00Z", cancelledAt: "2026-11-01T18:00:00Z", lines: [{ title: "Harbour mug", qty: 4, unit: 1800 }], discount: 0, shipping: [800], tax: 1040, expectTotal: 9040 },
  { number: 1007, processedAt: "2026-11-02T05:00:00Z", createdAt: "2026-11-02T04:50:00Z", presentment: { currency: "JPY", rate: [108, 1] }, lines: [{ title: "Wool throw", qty: 1, unit: 12000 }], discount: 0, shipping: [1200], tax: 1716, expectTotal: 14916 },
  {
    number: 1008,
    processedAt: "2026-11-02T18:00:00Z",
    presentment: { currency: "GBP", rate: [56, 100] },
    lines: [{ title: "Pine candle", qty: 2, unit: 3000 }, { title: "Tea tin", qty: 1, unit: 1250 }],
    discount: 725,
    shipping: [800],
    tax: 952,
    expectTotal: 8277,
    refunds: [{ processedAt: "2026-11-03T13:00:00Z", shipping: [{ subtotal: 800, tax: 104 }] }],
  },
  {
    number: 1009,
    processedAt: "2026-10-28T16:00:00Z",
    lines: [{ title: "Wool throw", qty: 1, unit: 12000 }],
    discount: 0,
    shipping: [0],
    tax: 1560,
    expectTotal: 13560,
    refunds: [{ processedAt: "2026-11-01T14:00:00Z", lines: [{ line: 0, qty: 1, subtotal: 12000, tax: 1560 }] }],
  },
  { number: 1010, processedAt: "2026-11-02T14:00:00Z", lines: [{ title: "Harbour mug", qty: 1, unit: 1800 }], discount: 0, shipping: [800], tax: 338, expectTotal: 2938 },
];

// -------------------------------------------------------------------------------------------- expansion

type Bag = { shopMoney: { amount: string; currencyCode: string }; presentmentMoney: { amount: string; currencyCode: string } };

/** shop cents -> presentment minor units, rounded half up, integers only. */
function convert(shopCents: number, spec: Spec): number {
  if (!spec.presentment) return shopCents;
  if (shopCents < 0) return -convert(-shopCents, spec); // symmetric rounding for reversals
  const [num, den] = spec.presentment.rate;
  const scale = 10 ** currencyExponent(spec.presentment.currency);
  const numerator = shopCents * num * scale;
  const denominator = den * 100;
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

function bag(spec: Spec, shopCents: number): Bag {
  const presentmentCurrency = spec.presentment?.currency ?? SHOP.currencyCode;
  return {
    shopMoney: { amount: formatMinor(shopCents, SHOP.currencyCode), currencyCode: SHOP.currencyCode },
    presentmentMoney: { amount: formatMinor(convert(shopCents, spec), presentmentCurrency), currencyCode: presentmentCurrency },
  };
}

/** A bag for a value that is the SUM of separately converted parts (so presentment totals add up exactly, as in the checkout). */
function sumBag(spec: Spec, shopParts: number[]): Bag {
  const presentmentCurrency = spec.presentment?.currency ?? SHOP.currencyCode;
  const shop = shopParts.reduce((a, b) => a + b, 0);
  const presentment = shopParts.reduce((a, b) => a + convert(b, spec), 0);
  return {
    shopMoney: { amount: formatMinor(shop, SHOP.currencyCode), currencyCode: SHOP.currencyCode },
    presentmentMoney: { amount: formatMinor(presentment, presentmentCurrency), currencyCode: presentmentCurrency },
  };
}

const plusMinutes = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString().replace(".000Z", "Z");

export function expandOrder(spec: Spec): Record<string, unknown> {
  const lineTotals = spec.lines.map((l) => l.qty * l.unit);
  const goods = lineTotals.reduce((a, b) => a + b, 0);
  const shippingTotal = spec.shipping.reduce((a, b) => a + b, 0);
  const total = goods - spec.discount + shippingTotal + spec.tax;
  if (total !== spec.expectTotal) throw new Error(`fixture #${spec.number}: hand-worked total ${spec.expectTotal} but the parts add up to ${total}`);

  const orderId = `gid://shopify/Order/${5_000_000_000 + spec.number}`;
  const presentmentCurrency = spec.presentment?.currency ?? SHOP.currencyCode;
  let refundSeq = 0;
  const refunds = (spec.refunds ?? []).map((r) => {
    refundSeq++;
    const refundId = `gid://shopify/Refund/${9_000_000_000 + spec.number * 10 + refundSeq}`;
    const lineParts = (r.lines ?? []).flatMap((l) => [l.subtotal, l.tax]);
    const shipParts = (r.shipping ?? []).flatMap((s) => [s.subtotal, s.tax]);
    const all = [...lineParts, ...shipParts];
    const refundedTotal = sumBag(spec, all);
    return {
      id: refundId,
      createdAt: r.processedAt,
      processedAt: r.processedAt,
      note: null,
      totalRefundedSet: refundedTotal,
      refundLineItems: {
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        nodes: (r.lines ?? []).map((l, i) => ({ id: `${refundId}/line/${i}`, quantity: l.qty, restocked: true, priceSet: bag(spec, spec.lines[l.line]!.unit), subtotalSet: bag(spec, l.subtotal), totalTaxSet: bag(spec, l.tax) })),
      },
      refundShippingLines: {
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        nodes: (r.shipping ?? []).map((s, i) => ({ id: `${refundId}/shipping/${i}`, subtotalAmountSet: bag(spec, s.subtotal), taxAmountSet: bag(spec, s.tax) })),
      },
      orderAdjustments: { pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, nodes: [] },
      transactions: {
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        nodes: [{ id: `${refundId}/tx/0`, kind: "REFUND", status: r.status ?? "SUCCESS", test: false, gateway: "bogus", createdAt: r.processedAt, processedAt: r.processedAt, amountSet: refundedTotal }],
      },
      _parts: all,
    };
  });
  const refundedParts = refunds.flatMap((r) => r._parts);
  const refundedTotalBag = refunds.length > 0 ? sumBag(spec, refundedParts) : bag(spec, 0);
  const currentParts = [total, ...refundedParts.map((p) => -p)];
  const lastTouch = [spec.processedAt, ...(spec.cancelledAt ? [spec.cancelledAt] : []), ...(spec.refunds ?? []).map((r) => r.processedAt)].sort().at(-1)!;

  return {
    id: orderId,
    name: `#${spec.number}`,
    createdAt: spec.createdAt ?? spec.processedAt,
    processedAt: spec.processedAt,
    updatedAt: plusMinutes(lastTouch, 5),
    cancelledAt: spec.cancelledAt ?? null,
    cancelReason: spec.cancelledAt ? "CUSTOMER" : null,
    closedAt: null,
    test: spec.test ?? false,
    taxesIncluded: false,
    displayFinancialStatus: spec.cancelledAt ? "VOIDED" : spec.refunds && spec.refunds.length > 0 ? (refundedParts.reduce((a, b) => a + b, 0) === total ? "REFUNDED" : "PARTIALLY_REFUNDED") : "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    currencyCode: SHOP.currencyCode,
    presentmentCurrencyCode: presentmentCurrency,
    subtotalPriceSet: sumBag(spec, [...lineTotals, -spec.discount]),
    totalPriceSet: sumBag(spec, [...lineTotals, -spec.discount, ...spec.shipping, spec.tax]),
    totalDiscountsSet: bag(spec, spec.discount),
    totalTaxSet: bag(spec, spec.tax),
    totalShippingPriceSet: sumBag(spec, spec.shipping),
    totalRefundedSet: refundedTotalBag,
    currentTotalPriceSet: sumBag(spec, [...lineTotals, -spec.discount, ...spec.shipping, spec.tax, ...currentParts.slice(1)]),
    lineItems: {
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      nodes: spec.lines.map((l, i) => ({ id: `gid://shopify/LineItem/${6_000_000_000 + spec.number * 10 + i}`, quantity: l.qty, currentQuantity: l.qty, isGiftCard: false, taxable: true, originalTotalSet: bag(spec, l.qty * l.unit), originalUnitPriceSet: bag(spec, l.unit) })),
    },
    shippingLines: {
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
      nodes: spec.shipping.map((p, i) => ({ id: `gid://shopify/ShippingLine/${7_000_000_000 + spec.number * 10 + i}`, title: "Standard", code: "standard", isRemoved: false, originalPriceSet: bag(spec, p), discountedPriceSet: bag(spec, p), currentDiscountedPriceSet: bag(spec, p) })),
    },
    refunds: refunds.map(({ _parts, ...rest }) => rest),
    transactions: [],
  };
}

export function buildOrders(specs: readonly Spec[] = SPECS): Array<Record<string, unknown>> {
  return specs.map(expandOrder);
}

export function fixtureDocument(): Record<string, unknown> {
  return {
    _note:
      "FICTIONAL data for shopify-kit. Generated by scripts/generate-fixtures.ts from testing/order-fixtures.ts. Shaped like Admin GraphQL order objects (API 2026-10) but NEVER exported from a Shopify store. Foreign-currency amounts use a fixed rate chosen for the fixture.",
    shop: SHOP,
    orders: buildOrders(),
  };
}
