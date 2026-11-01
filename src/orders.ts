// Orders: GraphQL shapes, the query this kit sends, and cursor pagination over it.
//
// Every field name below is taken from the Admin GraphQL reference (API version 2026-10, read 2026-11-01); see
// docs/SOURCES.md. The local mock Admin API validates the selection set against the same documented field
// lists, so a misspelled or invented field fails the tests instead of being discovered on a real store.
import { AdminClient, QueryCostError, ShopifyApiError, type GraphQLResult } from "./admin-client.ts";

export interface MoneyV2 {
  amount: string;
  currencyCode: string;
}
export interface MoneyBag {
  shopMoney?: MoneyV2;
  presentmentMoney?: MoneyV2;
}
export interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}
export interface Connection<T> {
  nodes: T[];
  pageInfo?: PageInfo;
}
export interface LineItem {
  id: string;
  quantity: number;
  isGiftCard: boolean;
  originalTotalSet: MoneyBag;
}
export interface ShippingLine {
  id: string;
  isRemoved: boolean;
  discountedPriceSet: MoneyBag;
}
export interface RefundLineItem {
  quantity: number;
  subtotalSet: MoneyBag;
  totalTaxSet: MoneyBag;
}
export interface RefundShippingLine {
  subtotalAmountSet: MoneyBag;
  taxAmountSet: MoneyBag;
}
export interface OrderAdjustment {
  amountSet: MoneyBag;
  taxAmountSet: MoneyBag;
  reason?: string | null;
}
export interface OrderTransaction {
  kind: string;
  status: string;
  amountSet: MoneyBag;
}
export interface Refund {
  id: string;
  createdAt: string;
  processedAt: string;
  totalRefundedSet: MoneyBag;
  refundLineItems: Connection<RefundLineItem>;
  refundShippingLines: Connection<RefundShippingLine>;
  orderAdjustments: Connection<OrderAdjustment>;
  transactions: Connection<OrderTransaction>;
}
export interface Order {
  id: string;
  name: string;
  createdAt: string;
  processedAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  test: boolean;
  taxesIncluded: boolean;
  displayFinancialStatus: string | null;
  currencyCode: string;
  presentmentCurrencyCode: string;
  subtotalPriceSet: MoneyBag | null;
  totalPriceSet: MoneyBag;
  totalDiscountsSet: MoneyBag | null;
  totalTaxSet: MoneyBag | null;
  currentTotalPriceSet: MoneyBag;
  lineItems: Connection<LineItem>;
  shippingLines: Connection<ShippingLine>;
  /** Order.refunds is a plain list (its `first` argument truncates), not a connection. */
  refunds: Refund[];
}

export interface NestedLimits {
  lineItems: number;
  shippingLines: number;
  refunds: number;
  refundLineItems: number;
  refundShippingLines: number;
  orderAdjustments: number;
  transactions: number;
}
export const DEFAULT_NESTED_LIMITS: NestedLimits = {
  lineItems: 10,
  shippingLines: 3,
  refunds: 3,
  refundLineItems: 5,
  refundShippingLines: 2,
  orderAdjustments: 2,
  transactions: 3,
};

export type MoneyMode = "shop" | "presentment";

/** `{ shopMoney { amount currencyCode } }` or the presentment equivalent: only the side that will be used is requested (cost). */
function bag(mode: MoneyMode): string {
  return mode === "shop" ? "{ shopMoney { amount currencyCode } }" : "{ presentmentMoney { amount currencyCode } }";
}

export function buildOrdersQuery(mode: MoneyMode = "shop", limits: NestedLimits = DEFAULT_NESTED_LIMITS): string {
  const m = bag(mode);
  return `query SalesOrders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      processedAt
      updatedAt
      cancelledAt
      test
      taxesIncluded
      displayFinancialStatus
      currencyCode
      presentmentCurrencyCode
      subtotalPriceSet ${m}
      totalPriceSet ${m}
      totalDiscountsSet ${m}
      totalTaxSet ${m}
      currentTotalPriceSet ${m}
      lineItems(first: ${limits.lineItems}) {
        pageInfo { hasNextPage }
        nodes { id quantity isGiftCard originalTotalSet ${m} }
      }
      shippingLines(first: ${limits.shippingLines}) {
        pageInfo { hasNextPage }
        nodes { id isRemoved discountedPriceSet ${m} }
      }
      refunds(first: ${limits.refunds}) {
        id
        createdAt
        processedAt
        totalRefundedSet ${m}
        refundLineItems(first: ${limits.refundLineItems}) {
          pageInfo { hasNextPage }
          nodes { quantity subtotalSet ${m} totalTaxSet ${m} }
        }
        refundShippingLines(first: ${limits.refundShippingLines}) {
          pageInfo { hasNextPage }
          nodes { subtotalAmountSet ${m} taxAmountSet ${m} }
        }
        orderAdjustments(first: ${limits.orderAdjustments}) {
          pageInfo { hasNextPage }
          nodes { amountSet ${m} taxAmountSet ${m} reason }
        }
        transactions(first: ${limits.transactions}) {
          pageInfo { hasNextPage }
          nodes { kind status amountSet ${m} }
        }
      }
    }
  }
}`;
}

/**
 * The search string for the `orders` query. Refunds are attributed to the day they are processed, so an order
 * placed before the reporting window can still contribute a reversal inside it; selecting by `updated_at` (which
 * a refund bumps) catches both. Orders are filtered by their own dates afterwards, in the aggregator.
 * Syntax per the orders query reference: `updated_at:>='2026-10-26T04:00:00Z'`, `test:false`.
 */
export function buildOrdersSearch(options: { updatedSince?: string; excludeTest?: boolean } = {}): string | null {
  const terms: string[] = [];
  if (options.updatedSince !== undefined) {
    if (Number.isNaN(Date.parse(options.updatedSince))) throw new Error(`updatedSince is not a valid timestamp: ${options.updatedSince}`);
    if (/['"\\]/.test(options.updatedSince)) throw new Error("updatedSince must not contain quotes");
    terms.push(`updated_at:>='${options.updatedSince}'`);
  }
  if (options.excludeTest ?? true) terms.push("test:false");
  return terms.length > 0 ? terms.join(" ") : null;
}

export class OrderShapeError extends ShopifyApiError {
  override name = "OrderShapeError";
}
export class PaginationError extends ShopifyApiError {
  override name = "PaginationError";
}

export const MAX_PAGE_SIZE = 250; // docs: "You can retrieve up to a maximum of 250 resources"
export const PAGINATION_CAP = 25_000; // docs: pagination of arrays of objects caps at 25,000 objects

export interface FetchOrdersOptions {
  mode?: MoneyMode;
  search?: string | null;
  /** Orders per page (default 2: the nested `first` limits multiply, see README "Cost"). Halved automatically on MAX_COST_EXCEEDED. */
  pageSize?: number;
  limits?: NestedLimits;
  /** Stop with an error instead of looping forever if a store returns more pages than this. Default 1000. */
  maxPages?: number;
  onPage?: (page: { orders: Order[]; pageNumber: number; pageSize: number; result: GraphQLResult<unknown> }) => void;
}

interface OrdersData {
  orders?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
}

function checkConnection(order: Order, field: string, conn: Connection<unknown> | undefined): void {
  if (!conn || !Array.isArray(conn.nodes)) throw new OrderShapeError(`order ${order.id}: ${field} missing from the response`);
  if (conn.pageInfo?.hasNextPage) {
    throw new OrderShapeError(`order ${order.id} has more ${field} than the ${conn.nodes.length} requested; raise the matching limit in FetchOrdersOptions.limits (a dashboard that silently drops rows cannot reconcile)`);
  }
}

/** Throws when a nested list was cut short by its `first` argument or the response lacks a required field. */
export function assertOrderComplete(order: Order, limits: NestedLimits): void {
  if (typeof order.id !== "string" || typeof order.processedAt !== "string") throw new OrderShapeError("an order in the response has no id or processedAt");
  checkConnection(order, "lineItems", order.lineItems);
  checkConnection(order, "shippingLines", order.shippingLines);
  if (!Array.isArray(order.refunds)) throw new OrderShapeError(`order ${order.id}: refunds missing from the response`);
  // Order.refunds has no pageInfo: a full list may have been truncated.
  if (order.refunds.length >= limits.refunds) {
    throw new OrderShapeError(`order ${order.id} has ${order.refunds.length} refunds, which reaches the requested limit of ${limits.refunds}; raise limits.refunds so truncation can be ruled out`);
  }
  for (const refund of order.refunds) {
    checkConnection(order, `refund ${refund.id} refundLineItems`, refund.refundLineItems);
    checkConnection(order, `refund ${refund.id} refundShippingLines`, refund.refundShippingLines);
    checkConnection(order, `refund ${refund.id} orderAdjustments`, refund.orderAdjustments);
    checkConnection(order, `refund ${refund.id} transactions`, refund.transactions);
  }
}

/** Async generator over the pages of the `orders` connection. */
export async function* iterateOrders(client: AdminClient, options: FetchOrdersOptions = {}): AsyncGenerator<Order[], void, void> {
  const mode = options.mode ?? "shop";
  const limits = options.limits ?? DEFAULT_NESTED_LIMITS;
  let pageSize = options.pageSize ?? 2;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) throw new Error(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  const query = buildOrdersQuery(mode, limits);
  const maxPages = options.maxPages ?? 1000;
  let after: string | null = null;
  const seenCursors = new Set<string>();
  let fetched = 0;
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    let result: GraphQLResult<OrdersData>;
    try {
      result = await client.graphql<OrdersData>(query, { first: pageSize, after, query: options.search ?? null });
    } catch (error) {
      // The single-query cost limit is checked on the REQUESTED cost, which scales with `first`: retry the same cursor with fewer orders.
      if (error instanceof QueryCostError && pageSize > 1) {
        pageSize = Math.max(1, Math.floor(pageSize / 2));
        pageNumber--;
        continue;
      }
      throw error;
    }
    const connection = result.data.orders;
    if (!connection || !Array.isArray(connection.nodes)) throw new OrderShapeError("response has no data.orders.nodes");
    const orders = connection.nodes as Order[];
    for (const order of orders) assertOrderComplete(order, limits);
    fetched += orders.length;
    options.onPage?.({ orders, pageNumber, pageSize, result });
    yield orders;
    const hasNext = connection.pageInfo?.hasNextPage === true;
    if (!hasNext) return;
    const endCursor = connection.pageInfo?.endCursor;
    if (typeof endCursor !== "string" || endCursor.length === 0) throw new PaginationError("hasNextPage is true but there is no endCursor");
    if (seenCursors.has(endCursor)) throw new PaginationError(`cursor ${endCursor} was returned twice; refusing to loop`);
    if (fetched >= PAGINATION_CAP) {
      throw new PaginationError(`reached the documented ${PAGINATION_CAP.toLocaleString("en-US")}-object pagination cap with more pages left; narrow the search (for example a shorter updated_at window) or use a bulk operation`);
    }
    seenCursors.add(endCursor);
    after = endCursor;
  }
  throw new PaginationError(`stopped after ${maxPages} pages`);
}

export async function fetchAllOrders(client: AdminClient, options: FetchOrdersOptions = {}): Promise<Order[]> {
  const all: Order[] = [];
  for await (const page of iterateOrders(client, options)) all.push(...page);
  return all;
}

export interface ShopInfo {
  name: string;
  myshopifyDomain: string;
  ianaTimezone: string;
  currencyCode: string;
}

/** Shop settings the aggregator needs: the reporting time zone and the shop currency (docs: Shop.ianaTimezone, Shop.currencyCode). */
export const SHOP_QUERY = `query ShopSettings { shop { name myshopifyDomain ianaTimezone currencyCode } }`;

export async function fetchShopInfo(client: AdminClient): Promise<ShopInfo> {
  const result = await client.graphql<{ shop?: Partial<ShopInfo> | null }>(SHOP_QUERY);
  const shop = result.data.shop;
  if (!shop || typeof shop.ianaTimezone !== "string" || typeof shop.currencyCode !== "string") {
    throw new OrderShapeError("shop query returned no ianaTimezone/currencyCode");
  }
  return { name: String(shop.name ?? ""), myshopifyDomain: String(shop.myshopifyDomain ?? ""), ianaTimezone: shop.ianaTimezone, currencyCode: shop.currencyCode };
}
