# Sources

Everything in this kit that says "Shopify does X" comes from the public pages below. There is no Shopify Partner
account and no development store behind this repository, so none of it was checked against a running Shopify.
Where a page was silent or ambiguous, the kit says so (README "Limits") instead of guessing quietly.

All pages were read on **2026-11-01**. Shopify's pages carry no "last updated" date, so the date is the day they
were fetched. At that date the latest stable Admin API version was **2026-10** (release candidate 2027-01), which
is the default version in the code. Docs change; re-read the pages before relying on a detail.

## How the pages were read

* Most pages were fetched from `shopify.dev` as raw markdown (the same URL with `.md` appended) with `curl`.
  Each fetched page was searched for the sections the kit depends on and those sections were read. Not every
  page was read cover to cover; very large ones (the Webhooks reference, the Shop object) were searched for the
  topics, payload samples and field names used here.
* Seven pages were also read as summaries returned by a page-fetch tool. A summary can drop detail, so the raw
  markdown is what field names and numbers were checked against.
* Two web searches were run to locate the `THROTTLED` error format and the sales-report definitions.
* The HTTP status of three Help Center sales-report URLs was probed (all 200) but their text was **not** read.
  The metric definitions therefore come from the ShopifyQL `sales` schema page, not from the Help Center.
* One page returned 404 (`.../authentication-authorization/access-token-types.md`) and was not used.

## Pages

### Webhooks

| URL | Used for |
|---|---|
| https://shopify.dev/docs/apps/build/webhooks/verify-deliveries | `X-Shopify-Hmac-SHA256` is a base64 HMAC-SHA256 of the raw body keyed with the client secret; constant-time compare; 401 on a mismatch; `X-Shopify-Webhook-Id` as the duplicate-detection key; secret rotation can take time to propagate |
| https://shopify.dev/docs/apps/build/webhooks/subscribe/https | HTTPS delivery: 5-second response limit, any non-2xx (including 3xx) counts as failure, 8 retries over 4 hours |
| https://shopify.dev/docs/apps/build/webhooks/delivery-structure | Delivery headers (`X-Shopify-Topic`, `X-Shopify-Shop-Domain`, `X-Shopify-Webhook-Id`, `X-Shopify-Event-Id`, `X-Shopify-API-Version`, `X-Shopify-Triggered-At`) and the difference between webhook id and event id |
| https://shopify.dev/docs/api/webhooks | Topic names and sample payloads (field names used by the order and refund handlers) |
| https://shopify.dev/docs/apps/build/privacy-law-compliance | The three mandatory compliance topics, their payload shapes, "respond with 2xx", invalid HMAC gets 401, 30-day completion window, timing of `customers/redact` and `shop/redact` |
| https://shopify.dev/docs/api/shopify-cli/app/app-webhook-trigger | How a developer sends a test webhook from the CLI (used in the setup guide) |

### Authentication and authorization

| URL | Used for |
|---|---|
| https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant | (The page's own metadata gives its title as "Authenticate a standalone or API-only app" and a canonical address under `.../authenticate-standalone-apps`.) The whole install flow: shop-domain pattern, `state`, hex query HMAC (sorted `key=value`, `hmac` removed), the token request, `expiring=1`, refresh-token rotation, granted-scope comparison |
| https://shopify.dev/docs/apps/build/authentication-authorization | Overview: which grant fits which app type, managed installation |
| https://shopify.dev/docs/api/usage/access-scopes | Scope names; `write_x` implies `read_x`; `read_orders` covers the last 60 days, `read_all_orders` needed for older orders |
| https://shopify.dev/docs/apps/build/scaffold-app | The CLI-scaffolded app path and why this kit's standalone OAuth module is only for apps with their own backend |
| https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration | `shopify.app.toml` (redirect URLs, scopes, webhook subscriptions) for the setup guide |
| https://shopify.dev/docs/apps/build/dev-dashboard/development-stores | Fetched at this URL, which served the page whose canonical address is https://shopify.dev/docs/apps/build/stores/development-stores. How a development store is created (`shopify store create dev`, Dev Dashboard), for the setup guide; none was created here |

### Admin GraphQL API

| URL | Used for |
|---|---|
| https://shopify.dev/docs/api/admin-graphql/latest | Endpoint shape `/admin/api/{version}/graphql.json`, `X-Shopify-Access-Token`, the list of error codes |
| https://shopify.dev/docs/api/usage/response-codes | GraphQL errors arrive as HTTP 200 with `errors[].extensions.code` (`THROTTLED`, `INTERNAL_SERVER_ERROR`, ...) |
| https://shopify.dev/docs/api/usage/versioning | Version naming, quarterly cadence, 12-month support, "always specify a version in your requests", an inaccessible version falls forward to the oldest accessible stable one and `X-Shopify-API-Version` on the response says which version answered |
| https://shopify.dev/docs/api/usage/limits | The leaky-bucket model and "the recommended backoff time is one second" (the page-fetch summary of this page claimed it contained no such detail; the raw markdown does, so the raw markdown was trusted) |
| https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits | Calculated query cost, per-plan bucket tables, `extensions.cost.throttleStatus`, the single-query limit of 1,000 points checked before execution |
| https://shopify.dev/docs/api/admin-rest/usage/rate-limits | Read only to confirm that the 429 / `Retry-After` model belongs to REST; the GraphQL client still honours a `Retry-After` header if one ever arrives |
| https://shopify.dev/docs/api/usage/pagination-graphql | Cursor pagination, `first` up to 250, `pageInfo.hasNextPage` / `endCursor`, the 25,000-object pagination cap |
| https://shopify.dev/docs/api/admin-graphql/latest/queries/orders | Arguments (`first`, `after`, `query`, `sortKey`); the default `sortKey` is `PROCESSED_AT`; the `processed_at` and `test` search filters |
| https://shopify.dev/docs/api/admin-graphql/latest/queries/shop | `shop { ianaTimezone currencyCode }` for the day-boundary time zone and the shop currency |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/Order | Order fields: `createdAt`, `processedAt`, `cancelledAt`, `test`, `taxesIncluded`, the `...Set` MoneyBag fields, `refunds` (a plain list, no `pageInfo`) |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/LineItem | Line item fields, `isGiftCard`, `originalTotalSet`, `discountedTotalSet` |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/ShippingLine | `originalPriceSet`, `discountedPriceSet`, `isRemoved` |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/Refund | `processedAt`, `refundLineItems`, `refundShippingLines`, `orderAdjustments`, `transactions`, `totalRefundedSet` |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/RefundLineItem | `subtotalSet`, `totalTaxSet`, `quantity` |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/RefundShippingLine | Refunded shipping and its tax |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/OrderAdjustment | Refund amounts that are neither items nor shipping nor tax |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/OrderTransaction | Transaction `kind`, `status`, amounts (used to ignore refunds whose money movement failed) |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/TaxLine | Tax line fields |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/MoneyBag | `shopMoney` vs `presentmentMoney`, both non-null |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/MoneyV2 | `amount` is a decimal string, `currencyCode` |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/PageInfo | Pagination fields |
| https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop | Shop fields |
| https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderDisplayFinancialStatus | Financial status values used in fixtures |
| https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderTransactionKind | Transaction kinds |
| https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderTransactionStatus | Transaction statuses |
| https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderCancelReason | Cancel reasons used in fixtures |
| https://shopify.dev/docs/api/admin-graphql/latest/enums/OrderSortKeys | Sort keys the mock accepts (read on the fly while building the mock, not kept as a file) |

### Sales definitions

| URL | Used for |
|---|---|
| https://shopify.dev/docs/api/shopifyql/latest/schemas/sales_revenue/sales | Definitions of `gross_sales`, `discounts`, `net_sales`, `net_sales_reversals`, `shipping_charges`, `shipping_reversals`, `taxes`, `tax_reversals`, `total_sales`, `orders`; "each row records one event", which is why refunds are attributed to the refund's own date; the `is_canceled_order` dimension |

### Theme check

| URL | Used for |
|---|---|
| https://shopify.dev/docs/storefronts/themes/tools/theme-check | What theme-check is |
| https://shopify.dev/docs/storefronts/themes/tools/theme-check/checks | The list of checks (`ParserBlockingScript`, `UndefinedObject`, `UnusedAssign`, `ImgWidthAndHeight`, `MissingTemplate`) |
| https://shopify.dev/docs/storefronts/themes/tools/theme-check/commands | Command-line usage |
| https://shopify.dev/docs/storefronts/themes/tools/theme-check/configuration | `.theme-check.yml`, `extends: theme-check:recommended` |

### Not a web page

* The npm package `@shopify/theme-check-node` 3.31.0 (a dev dependency here). Its bundled Liquid reference
  documentation (revision `40f966fc7793462726d9f8573c8d522f8ab44c54`) is what `--offline` runs use.

## Questions the pages did not answer

These are listed in the README under "Limits" because a different answer would change the numbers:

* Which date Shopify's own sales report uses to place an order on a day (this kit defaults to `processedAt`).
* Whether `net_sales` subtracts reversals measured before or after discounts (this kit uses after discounts).
* Whether `total_sales` in a report nets shipping and tax reversals (this kit nets them).
* The exact cost formula and bucket sizes per plan (the mock uses a toy model).
* A maximum webhook payload size.
* Whether a cancelled order can be un-cancelled (the kit treats cancellation as permanent).
