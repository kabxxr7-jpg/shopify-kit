// Sales aggregator over Admin GraphQL order objects. All arithmetic is on integer minor units.
//
// Metric names follow the ShopifyQL `sales` schema (shopify.dev, API 2026-10, read 2026-11-01):
//   gross_sales            line items before discounts and returns; excludes taxes, shipping, duties, fees
//   discounts              amount taken off sales revenue through discounts
//   net_sales_reversals    value of items removed from orders AFTER discounts, BEFORE taxes
//   net_sales              = gross_sales - discounts - sales reversals
//   shipping_charges       after shipping discounts, before shipping taxes
//   shipping_reversals     shipping charges removed from orders
//   taxes / tax_reversals  taxes charged / removed
//   total_sales            "net sales + additional fees + duties + shipping charges + taxes"
//   orders                 each order counted once
// "Each row records one event, and a single order can produce multiple rows if refunds or adjustments follow":
// the sale is attributed to the order's date, every refund to the refund's own processedAt date.
//
// Interpretations the docs leave open (README "Limits" lists them):
//   * the `net_sales` formula says "sales reversals"; the item value after discounts is used (net_sales_reversals);
//   * total_sales is computed with shipping and taxes NET of their reversals, so a fully refunded order totals 0;
//   * RefundLineItem.subtotalSet is taken to be the refunded item value after discounts;
//   * other_refunds (kit-specific) = money refunded that is neither item, shipping nor tax (order adjustments).
//
// Policy, not Shopify behaviour: test orders and cancelled orders are EXCLUDED entirely (their refunds too).
// ShopifyQL keeps cancelled orders and exposes `is_canceled_order`; excluding them equals filtering
// `WHERE is_canceled_order = false`.
import { MoneyError, addMinor, currencyExponent, parseDecimalToMinor } from "./money.ts";
import type { MoneyBag, MoneyMode, Order, Refund } from "./orders.ts";
import { assertTimeZone, isLocalDay, localDay } from "./tz.ts";

export type IssueCode =
  | "TAX_INCLUDED_UNSUPPORTED"
  | "GIFT_CARD_UNSUPPORTED"
  | "MISSING_MONEY"
  | "CURRENCY_MISMATCH"
  | "SUBTOTAL_MISMATCH"
  | "TOTAL_MISMATCH"
  | "REFUND_TOTAL_MISMATCH"
  | "REFUND_ADJUSTMENT"
  | "REFUND_PENDING"
  | "REFUND_FAILED_TRANSACTIONS"
  | "CURRENT_TOTAL_DIFFERS"
  | "BAD_AMOUNT";

export interface Issue {
  severity: "error" | "warning";
  code: IssueCode;
  orderId: string;
  orderName: string;
  message: string;
}

export class AggregationError extends Error {
  override name = "AggregationError";
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(`${issues.length} order(s) cannot be aggregated safely: ${issues.map((i) => `${i.orderName} ${i.code}`).join(", ")}`);
    this.issues = issues;
  }
}

export interface AggregateOptions {
  /** IANA zone used for day boundaries; take it from Shop.ianaTimezone. Required: there is no sensible default. */
  timeZone: string;
  /** "shop" (default): Shop currency, as Shopify's reports are shown. "presentment": the customer's currency, one bucket per currency. */
  currency?: MoneyMode;
  /** Which timestamp places an order on a day. Default processedAt. The docs read do not say which one Shopify's reports use. */
  dateField?: "processedAt" | "createdAt";
  /** Inclusive local-day window, YYYY-MM-DD in `timeZone`. Events (sales or refunds) outside it are dropped. */
  from?: string;
  until?: string;
  excludeTest?: boolean;
  excludeCancelled?: boolean;
  /** Default true: throw AggregationError if any order has an error-level issue. False: leave those orders out and report them. */
  strict?: boolean;
}

export interface Metrics {
  orders: number;
  gross_sales: number;
  discounts: number;
  net_sales_reversals: number;
  net_sales: number;
  shipping_charges: number;
  shipping_reversals: number;
  taxes: number;
  tax_reversals: number;
  other_refunds: number;
  total_sales: number;
}
export interface Row extends Metrics {
  day: string;
  currency: string;
}
export interface AggregateResult {
  rows: Row[];
  totals: Record<string, Metrics>;
  counted: { orders: number; refunds: number };
  excluded: { test: number; cancelled: number; unsupported: number; refundsNotCounted: number };
  issues: Issue[];
  /** False when an order had to be left out because of an error-level issue (only possible with strict: false). */
  complete: boolean;
}

const emptyMetrics = (): Metrics => ({
  orders: 0,
  gross_sales: 0,
  discounts: 0,
  net_sales_reversals: 0,
  net_sales: 0,
  shipping_charges: 0,
  shipping_reversals: 0,
  taxes: 0,
  tax_reversals: 0,
  other_refunds: 0,
  total_sales: 0,
});

function derive(m: Metrics): void {
  m.net_sales = m.gross_sales - m.discounts - m.net_sales_reversals;
  m.total_sales = m.net_sales + (m.shipping_charges - m.shipping_reversals) + (m.taxes - m.tax_reversals) - m.other_refunds;
}

interface SaleEvent {
  kind: "sale";
  day: string;
  gross: number;
  discounts: number;
  shipping: number;
  taxes: number;
}
interface ReversalEvent {
  kind: "reversal";
  day: string;
  items: number;
  shipping: number;
  taxes: number;
  other: number;
}

class OrderProblem extends Error {
  readonly issue: Omit<Issue, "orderId" | "orderName">;
  constructor(issue: Omit<Issue, "orderId" | "orderName">) {
    super(issue.message);
    this.issue = issue;
  }
}

export function aggregateSales(orders: readonly Order[], options: AggregateOptions): AggregateResult {
  assertTimeZone(options.timeZone);
  for (const [name, value] of [["from", options.from], ["until", options.until]] as const) {
    if (value !== undefined && !isLocalDay(value)) throw new Error(`${name} must be a YYYY-MM-DD calendar day, got ${JSON.stringify(value)}`);
  }
  if (options.from !== undefined && options.until !== undefined && options.from > options.until) throw new Error("from is after until");
  const mode: MoneyMode = options.currency ?? "shop";
  const dateField = options.dateField ?? "processedAt";
  const excludeTest = options.excludeTest ?? true;
  const excludeCancelled = options.excludeCancelled ?? true;
  const strict = options.strict ?? true;

  const issues: Issue[] = [];
  const buckets = new Map<string, Row>();
  const counted = { orders: 0, refunds: 0 };
  const excluded = { test: 0, cancelled: 0, unsupported: 0, refundsNotCounted: 0 };

  const inWindow = (day: string): boolean => (options.from === undefined || day >= options.from) && (options.until === undefined || day <= options.until);
  const bucket = (day: string, currency: string): Row => {
    const key = `${day}|${currency}`;
    let row = buckets.get(key);
    if (!row) {
      row = { day, currency, ...emptyMetrics() };
      buckets.set(key, row);
    }
    return row;
  };

  for (const order of orders) {
    if (order.test && excludeTest) {
      excluded.test++;
      continue;
    }
    if (order.cancelledAt && excludeCancelled) {
      excluded.cancelled++;
      continue;
    }
    const orderIssues: Issue[] = [];
    const note = (partial: Omit<Issue, "orderId" | "orderName">): void => {
      orderIssues.push({ ...partial, orderId: order.id, orderName: order.name });
    };
    let sale: SaleEvent;
    let reversals: ReversalEvent[];
    let skippedRefunds = 0;
    const currency = mode === "shop" ? order.currencyCode : order.presentmentCurrencyCode;
    try {
      ({ sale, reversals, skippedRefunds } = analyseOrder(order, mode, currency, dateField, options.timeZone, note));
    } catch (error) {
      if (error instanceof OrderProblem) note(error.issue);
      else if (error instanceof MoneyError) note({ severity: "error", code: "BAD_AMOUNT", message: error.message });
      else throw error;
    }
    issues.push(...orderIssues);
    if (orderIssues.some((i) => i.severity === "error")) {
      excluded.unsupported++;
      continue;
    }
    excluded.refundsNotCounted += skippedRefunds;
    if (inWindow(sale!.day)) {
      const row = bucket(sale!.day, currency);
      row.orders += 1;
      row.gross_sales += sale!.gross;
      row.discounts += sale!.discounts;
      row.shipping_charges += sale!.shipping;
      row.taxes += sale!.taxes;
      counted.orders++;
    }
    for (const r of reversals!) {
      if (!inWindow(r.day)) continue;
      const row = bucket(r.day, currency);
      row.net_sales_reversals += r.items;
      row.shipping_reversals += r.shipping;
      row.tax_reversals += r.taxes;
      row.other_refunds += r.other;
      counted.refunds++;
    }
  }

  const errors = issues.filter((i) => i.severity === "error");
  if (strict && errors.length > 0) throw new AggregationError(errors);

  const rows = [...buckets.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  const totals: Record<string, Metrics> = {};
  for (const row of rows) {
    derive(row);
    const t = (totals[row.currency] ??= emptyMetrics());
    for (const k of ["orders", "gross_sales", "discounts", "net_sales_reversals", "shipping_charges", "shipping_reversals", "taxes", "tax_reversals", "other_refunds"] as const) {
      t[k] = addMinor(t[k], row[k]);
    }
  }
  for (const t of Object.values(totals)) derive(t);
  return { rows, totals, counted, excluded, issues, complete: errors.length === 0 };
}

function pick(bag: MoneyBag | null | undefined, mode: MoneyMode, currency: string, what: string): number {
  if (!bag) throw new OrderProblem({ severity: "error", code: "MISSING_MONEY", message: `${what} is missing` });
  const money = mode === "shop" ? bag.shopMoney : bag.presentmentMoney;
  if (!money) throw new OrderProblem({ severity: "error", code: "MISSING_MONEY", message: `${what} has no ${mode === "shop" ? "shopMoney" : "presentmentMoney"}` });
  if (money.currencyCode !== currency) {
    throw new OrderProblem({ severity: "error", code: "CURRENCY_MISMATCH", message: `${what} is in ${money.currencyCode} but the order's ${mode} currency is ${currency}` });
  }
  return parseDecimalToMinor(money.amount, money.currencyCode);
}

function analyseOrder(
  order: Order,
  mode: MoneyMode,
  currency: string,
  dateField: "processedAt" | "createdAt",
  timeZone: string,
  note: (issue: Omit<Issue, "orderId" | "orderName">) => void,
): { sale: SaleEvent; reversals: ReversalEvent[]; skippedRefunds: number } {
  currencyExponent(currency); // unknown currency -> MoneyError -> BAD_AMOUNT
  if (order.taxesIncluded) {
    throw new OrderProblem({
      severity: "error",
      code: "TAX_INCLUDED_UNSUPPORTED",
      message: "taxesIncluded is true: Shopify's order-level prices then include tax and the docs do not give a rule to split gross sales and discounts into net and tax; refusing to guess",
    });
  }
  if (order.lineItems.nodes.some((l) => l.isGiftCard)) {
    throw new OrderProblem({ severity: "error", code: "GIFT_CARD_UNSUPPORTED", message: "order contains a gift card line; Shopify reports gift card sales separately and the docs read do not say how gross_sales treats them" });
  }

  const gross = addMinor(...order.lineItems.nodes.map((l) => pick(l.originalTotalSet, mode, currency, `line item ${l.id} originalTotalSet`)));
  const discounts = order.totalDiscountsSet ? pick(order.totalDiscountsSet, mode, currency, "totalDiscountsSet") : 0;
  const shipping = addMinor(...order.shippingLines.nodes.filter((s) => !s.isRemoved).map((s) => pick(s.discountedPriceSet, mode, currency, `shipping line ${s.id} discountedPriceSet`)));
  const taxes = order.totalTaxSet ? pick(order.totalTaxSet, mode, currency, "totalTaxSet") : 0;

  if (order.subtotalPriceSet) {
    const subtotal = pick(order.subtotalPriceSet, mode, currency, "subtotalPriceSet");
    if (subtotal !== gross - discounts) {
      note({ severity: "error", code: "SUBTOTAL_MISMATCH", message: `subtotalPriceSet is ${subtotal} but line items minus discounts is ${gross - discounts}` });
    }
  }
  const totalPrice = pick(order.totalPriceSet, mode, currency, "totalPriceSet");
  const rebuilt = gross - discounts + shipping + taxes;
  if (totalPrice !== rebuilt) {
    note({
      severity: "error",
      code: "TOTAL_MISMATCH",
      message: `totalPriceSet is ${totalPrice} but gross - discounts + shipping + taxes is ${rebuilt} (tips, duties, additional fees, cash rounding or a shipping discount counted in totalDiscountsSet are not modelled)`,
    });
  }

  const sale: SaleEvent = { kind: "sale", day: localDay(order[dateField], timeZone), gross, discounts, shipping, taxes };

  const reversals: ReversalEvent[] = [];
  let skippedRefunds = 0;
  let itemisedReversals = 0;
  for (const refund of order.refunds) {
    const verdict = judgeRefund(refund);
    if (verdict === "failed") {
      skippedRefunds++;
      note({ severity: "warning", code: "REFUND_FAILED_TRANSACTIONS", message: `refund ${refund.id} has only FAILURE/ERROR transactions, so no money moved; not counted` });
      continue;
    }
    if (verdict === "pending") {
      note({ severity: "warning", code: "REFUND_PENDING", message: `refund ${refund.id} has no SUCCESS transaction yet (pending/unknown); counted at its processedAt date` });
    }
    const items = addMinor(...refund.refundLineItems.nodes.map((r) => pick(r.subtotalSet, mode, currency, `refund ${refund.id} line subtotalSet`)));
    const itemTax = addMinor(...refund.refundLineItems.nodes.map((r) => pick(r.totalTaxSet, mode, currency, `refund ${refund.id} line totalTaxSet`)));
    const shipRev = addMinor(...refund.refundShippingLines.nodes.map((r) => pick(r.subtotalAmountSet, mode, currency, `refund ${refund.id} shipping subtotalAmountSet`)));
    const shipTax = addMinor(...refund.refundShippingLines.nodes.map((r) => pick(r.taxAmountSet, mode, currency, `refund ${refund.id} shipping taxAmountSet`)));
    const refunded = pick(refund.totalRefundedSet, mode, currency, `refund ${refund.id} totalRefundedSet`);
    const explained = items + itemTax + shipRev + shipTax;
    let other = 0;
    if (refunded !== explained) {
      if (refund.orderAdjustments.nodes.length > 0) {
        other = refunded - explained;
        note({ severity: "warning", code: "REFUND_ADJUSTMENT", message: `refund ${refund.id}: ${other} of ${refunded} is refunded outside items, shipping and tax (order adjustment); reported as other_refunds` });
      } else {
        note({ severity: "error", code: "REFUND_TOTAL_MISMATCH", message: `refund ${refund.id} totalRefundedSet is ${refunded} but items + shipping + tax is ${explained} and there is no order adjustment to explain the difference` });
      }
    }
    itemisedReversals += explained;
    reversals.push({ kind: "reversal", day: localDay(refund.processedAt, timeZone), items, shipping: shipRev, taxes: itemTax + shipTax, other });
  }

  const current = pick(order.currentTotalPriceSet, mode, currency, "currentTotalPriceSet");
  if (current !== totalPrice - itemisedReversals) {
    note({
      severity: "warning",
      code: "CURRENT_TOTAL_DIFFERS",
      message: `currentTotalPriceSet is ${current} but totalPriceSet minus itemised refunds is ${totalPrice - itemisedReversals} (the docs say only "after returns"; refunds without returned items are one possible cause)`,
    });
  }
  return { sale, reversals, skippedRefunds };
}

/** Docs (Refund object): a Refund existing does not prove money moved; check the transactions' status. */
function judgeRefund(refund: Refund): "ok" | "pending" | "failed" {
  const tx = refund.transactions.nodes;
  if (tx.length === 0) return "ok"; // nothing contradicts it (for example a refund on an unpaid order)
  if (tx.some((t) => t.status === "SUCCESS")) return "ok";
  if (tx.every((t) => t.status === "FAILURE" || t.status === "ERROR")) return "failed";
  return "pending";
}
