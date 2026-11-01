// The slice of the Admin GraphQL schema the mock Admin API will accept. Field names and kinds come from the
// object reference pages (API 2026-10, read 2026-11-01): Order, LineItem, ShippingLine, Refund, RefundLineItem,
// RefundShippingLine, OrderAdjustment, OrderTransaction, MoneyBag, MoneyV2, PageInfo, Shop. A query that selects
// anything else is answered with a GraphQL error, exactly so an invented field name fails a test.
//
// kinds: scalar | object | connection (nodes + pageInfo, takes first/after) | list (plain array, `first` truncates)
export type Kind = "scalar" | "object" | "connection" | "list";
export interface FieldDef {
  kind: Kind;
  type?: string;
}

const s: FieldDef = { kind: "scalar" };
const obj = (type: string): FieldDef => ({ kind: "object", type });
const conn = (type: string): FieldDef => ({ kind: "connection", type });
const list = (type: string): FieldDef => ({ kind: "list", type });

export const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Order: {
    id: s, name: s, createdAt: s, processedAt: s, updatedAt: s, cancelledAt: s, cancelReason: s, closedAt: s, test: s, taxesIncluded: s,
    displayFinancialStatus: s, displayFulfillmentStatus: s, currencyCode: s, presentmentCurrencyCode: s, email: s,
    subtotalPriceSet: obj("MoneyBag"), totalPriceSet: obj("MoneyBag"), totalDiscountsSet: obj("MoneyBag"), totalTaxSet: obj("MoneyBag"),
    totalShippingPriceSet: obj("MoneyBag"), totalRefundedSet: obj("MoneyBag"), totalReceivedSet: obj("MoneyBag"), netPaymentSet: obj("MoneyBag"),
    originalTotalPriceSet: obj("MoneyBag"), currentTotalPriceSet: obj("MoneyBag"), currentSubtotalPriceSet: obj("MoneyBag"),
    currentTotalTaxSet: obj("MoneyBag"), currentTotalDiscountsSet: obj("MoneyBag"), currentShippingPriceSet: obj("MoneyBag"),
    lineItems: conn("LineItem"), shippingLines: conn("ShippingLine"), refunds: list("Refund"), transactions: list("OrderTransaction"),
  },
  LineItem: {
    id: s, quantity: s, currentQuantity: s, isGiftCard: s, taxable: s, originalTotalSet: obj("MoneyBag"), originalUnitPriceSet: obj("MoneyBag"),
    discountedTotalSet: obj("MoneyBag"), totalDiscountSet: obj("MoneyBag"),
  },
  ShippingLine: { id: s, title: s, code: s, isRemoved: s, originalPriceSet: obj("MoneyBag"), discountedPriceSet: obj("MoneyBag"), currentDiscountedPriceSet: obj("MoneyBag") },
  Refund: {
    id: s, createdAt: s, processedAt: s, note: s, totalRefundedSet: obj("MoneyBag"),
    refundLineItems: conn("RefundLineItem"), refundShippingLines: conn("RefundShippingLine"), orderAdjustments: conn("OrderAdjustment"), transactions: conn("OrderTransaction"),
  },
  RefundLineItem: { id: s, quantity: s, restocked: s, priceSet: obj("MoneyBag"), subtotalSet: obj("MoneyBag"), totalTaxSet: obj("MoneyBag") },
  RefundShippingLine: { id: s, subtotalAmountSet: obj("MoneyBag"), taxAmountSet: obj("MoneyBag") },
  OrderAdjustment: { id: s, reason: s, amountSet: obj("MoneyBag"), taxAmountSet: obj("MoneyBag") },
  OrderTransaction: { id: s, kind: s, status: s, test: s, gateway: s, createdAt: s, processedAt: s, amountSet: obj("MoneyBag") },
  MoneyBag: { shopMoney: obj("MoneyV2"), presentmentMoney: obj("MoneyV2") },
  MoneyV2: { amount: s, currencyCode: s },
  PageInfo: { hasNextPage: s, hasPreviousPage: s, startCursor: s, endCursor: s },
  Shop: { id: s, name: s, myshopifyDomain: s, ianaTimezone: s, currencyCode: s, timezoneAbbreviation: s, timezoneOffset: s },
};

export const ROOT: Record<string, FieldDef> = {
  orders: conn("Order"),
  shop: obj("Shop"),
};

/** Valid OrderSortKeys values per the enum reference. */
export const ORDER_SORT_KEYS = ["CREATED_AT", "CURRENT_TOTAL_PRICE", "CUSTOMER_NAME", "DESTINATION", "FINANCIAL_STATUS", "FULFILLMENT_STATUS", "ID", "ORDER_NUMBER", "PO_NUMBER", "PROCESSED_AT", "RELEVANCE", "TOTAL_ITEMS_QUANTITY", "TOTAL_PRICE", "UPDATED_AT"];
