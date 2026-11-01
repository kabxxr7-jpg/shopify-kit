# shopify-kit

Building blocks for Shopify custom-app and theme work, with the proof that each block behaves as described:

* a webhook receiver (raw-body HMAC, dedupe, the three compliance topics, out-of-order safe),
* the app install (OAuth) flow with every validation the docs list,
* an Admin GraphQL orders client (cost-aware pacing, backoff, pinned API version, cursor pagination),
* an orders sales dashboard engine that is reconciled to a "Shopify report" to the cent,
* a small Liquid theme with five planted problems, found and fixed with the real `theme-check`.

**Status (2026-11-01): working code, tests green, never run on Shopify.** There was no Shopify Partner account or
development store, so everything runs against a local mock Admin API and fixtures built from Shopify's public
documentation (read 2026-11-01, see [docs/SOURCES.md](docs/SOURCES.md)). Nothing here claims a result from a real
store. [docs/GO-LIVE-CHECKLIST.md](docs/GO-LIVE-CHECKLIST.md) lists what to confirm on a development store, and its
"ran on a dev store on" line is blank.

Fictional data only: the shop "Harbour & Pine Goods" (`harbour-pine-demo.myshopify.com`), its orders and its
customers do not exist. The client secret in the tests is a made-up string.

## Quickstart

Node 25 or newer (uses `node:sqlite` and runs TypeScript directly), npm.

```sh
npm ci
npm test                         # the full suite
npm run typecheck
npm run serve -- --demo          # the app on a free port in 4770-4789, with a mock Shopify behind it
npm run reconcile                # dashboard numbers vs the hand-written report; exit 0 = match to the cent
npm run theme:check -- theme/before --offline   # 5 offenses, real theme-check
npm run theme:check -- theme/after  --offline   # 0 offenses
```

More detail, including a signed `curl` against the demo server and the steps for a real development store:
[docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md).

## What is where

| Path | Contents |
|---|---|
| `src/hmac.ts`, `src/shop.ts` | Webhook HMAC (base64, raw body) and OAuth query HMAC (hex, sorted), constant-time; shop-domain validation |
| `src/oauth.ts` | Install redirect, callback validation, code exchange, refresh with rotation, scope check, one-time `state` store |
| `src/webhooks.ts`, `src/dedupe.ts`, `src/handlers.ts`, `src/compliance.ts`, `src/db.ts` | Receiver, dedupe store (memory and SQLite), order and refund handlers, compliance topics, schema |
| `src/server.ts`, `scripts/serve.ts` | A small `node:http` app: `/health`, `/webhooks`, `/auth/install`, `/auth/callback` |
| `src/admin-client.ts`, `src/orders.ts` | GraphQL client and the orders query, pagination, completeness checks |
| `src/money.ts`, `src/tz.ts`, `src/aggregate.ts`, `src/reconcile.ts` | Integer minor-unit math, time-zone day buckets, sales metrics, reconciliation |
| `testing/` | The local mock Shopify (token endpoint and Admin API), fixture builders, signing helpers |
| `fixtures/` | `orders.json` (generated), `shopify-report.shop.json` and `shopify-report.presentment.json` (hand-written) |
| `theme/before`, `theme/after`, `theme/results` | The sample theme, its fix, and the captured theme-check output |
| `scripts/mutation-check.mjs` | The mutation check (see below) |
| `docs/` | Setup guide, go-live checklist, not-covered list, sources |

## 1. Webhook receiver

`handleShopifyWebhook` takes the **raw** body and the headers and returns a status and a JSON body, so it works
with any framework (`src/server.ts` shows it on `node:http`). Order of work:

1. A body that is not raw bytes or text (for example the result of `express.json()`) is refused with 400: it cannot
   be verified.
2. `X-Shopify-Hmac-SHA256` must equal `base64(HMAC-SHA256(raw body, client secret))`. The comparison is
   `crypto.timingSafeEqual` on the decoded bytes, after a format check so that a malformed header is refused before
   the comparison. Missing or wrong: **401**. Several secrets can be given, to accept old and new during a rotation.
3. Topic, shop domain (validated against the install pattern), webhook id are required (400 otherwise).
4. The body is parsed with `JSON.parse` using the `context.source` reviver, so ids above 2^53 stay exact digit
   strings. Plain `JSON.parse` rounds them; that was a real bug found while testing, and ids are stored as TEXT.
5. Dedupe on `X-Shopify-Webhook-Id` (a unique key per delivery). A second delivery of the same id gets 200 and no
   second effect. A delivery that is still being handled gets 409 so that Shopify retries later; a crashed worker's
   claim expires after a lock timeout. `X-Shopify-Event-Id` is shared by duplicate subscriptions of one action; it is used
   (together with the topic) as the key only if you set `dedupeBy: "event-id-and-topic"`.
6. Routing: the compliance topics are validated, recorded and executed; other topics go to your handlers; a topic
   nobody handles is acknowledged with 200 so it is not retried.
7. 200 is sent only after the handler finished. A handler that throws releases the claim and answers 500, so
   Shopify's retries (8 over 4 hours according to the docs) run it again.

**Compliance topics.** `customers/data_request`, `customers/redact` and `shop/redact` are recorded in
`compliance_requests` (one row per delivery, with a 30-day due date), and the erasure runs for the data this kit
stores: the order's email and customer id for `customers/redact` (and the email and phone in the stored request
itself); the stored orders, refunds and access token of the shop for `shop/redact`. The `compliance_requests` row
stays as the record that the request was received and handled.
`customers/data_request` is recorded and acknowledged; delivering the data to the merchant is left to you.
A redaction leaves a tombstone, so a late, older `orders/updated` cannot bring the email back.

**Out of order and repeated delivery.** Order handlers are idempotent upserts keyed by the order id: an event whose
`updated_at` is older than the newest one applied does not overwrite it; `cancelled_at` is sticky; a refund may
arrive before its order. The stickiness of cancellation is this kit's rule; the docs read do not say whether a
cancellation can be undone.

| Situation | Answer |
|---|---|
| Wrong, missing or malformed signature | 401 |
| Body not raw, not UTF-8, not JSON; missing topic, shop or webhook id | 400 |
| Same webhook id already handled | 200 (`duplicate`) |
| Same webhook id being handled right now | 409 |
| Handler threw | 500, claim released |
| Unknown topic | 200 |

## 2. Install flow

`beginInstall` validates `shop` against the documented pattern `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$`
(anchored at both ends; the docs warn that a missing `$` lets `x.myshopify.com.attacker.example` through), creates a
random `state`, and redirects to `https://{shop}/admin/oauth/authorize` with the configured `redirect_uri` (never
taken from the request). `handleCallback` then checks, in this order: shop pattern, query HMAC (hex, `hmac` removed,
parameters sorted, constant-time), `state` equals the cookie **and** was issued by this server, for this shop,
**once**, then a code is present, then exchanges it (form-encoded POST, `expiring=1` by default, redirects not
followed so the client secret cannot be forwarded) and compares the granted scopes with the requested ones (a
`write_x` grant covers `read_x`). A token with fewer scopes than requested is refused, not stored.
`refreshAccessToken` implements the refresh-token grant and returns the new refresh token, which replaces the old
one (rotation).

Tested against the local mock's token endpoint, including: forged and missing `hmac`, tampered parameters, replayed
and cross-shop `state`, hosts such as `evil.example` and `x.myshopify.com.evil.example`, a token endpoint that
redirects, a 4xx/5xx token response, fewer scopes than requested.

This is the flow for standalone or API-only apps. CLI-scaffolded apps use managed installation and do not run it.

## 3. Admin API client and orders

`AdminClient` posts to `https://{shop}/admin/api/{version}/graphql.json` with `X-Shopify-Access-Token`.

* **Pinned, configurable version.** Default `2026-10` (the latest stable on 2026-11-01), always sent, validated
  (`YYYY-MM` with month 01/04/07/10, or `unstable`). Shopify answers an inaccessible version with the oldest
  accessible one; the answering version (`X-Shopify-API-Version`) is returned on every result, and `strictVersion`
  turns a mismatch into an error.
* **Errors in a 200.** GraphQL errors are read from `errors[].extensions.code`: `THROTTLED` (wait and retry),
  `MAX_COST_EXCEEDED` (the orders fetch halves the page size), `ACCESS_DENIED` and HTTP 401/403 (stop with
  `AuthError`, no retry), `INTERNAL_SERVER_ERROR` and HTTP 5xx/429/network errors (retry with jittered exponential
  backoff), `SHOP_INACTIVE`. A response that has both `data` and `errors` is a partial result and is refused unless
  `allowPartial` is set.
* **Cost-aware pacing.** `extensions.cost.throttleStatus` is tracked. Before a query whose requested cost (learnt
  from the same query shape's previous response) does not fit the bucket, the client waits for the bucket to refill
  (capped at `maxBackoffMs`). After a `THROTTLED` answer it waits at least one second ("the recommended backoff time
  is one second"), long enough for the bucket to refill at the reported restore rate, never more than
  `maxBackoffMs`. For HTTP 429 and 5xx answers the wait is jittered exponential backoff, and a `Retry-After` header
  is honoured even when it is longer than `maxBackoffMs`.
* **Orders.** `iterateOrders` / `fetchAllOrders` page with `first`/`after`/`endCursor`, sorted by `UPDATED_AT`
  (a refund bumps `updatedAt`, so an old order refunded inside the window is found). A repeated cursor, a
  `hasNextPage` without a cursor, the 25,000-object pagination cap and more pages than `maxPages` are errors, not
  silent stops. Nested lists (line items, shipping lines, refunds and their parts) are requested with fixed `first`
  limits; if any list reaches its limit the fetch **fails** instead of returning a short order, because a dashboard
  that silently drops rows cannot reconcile.
* **Money.** `shop` mode requests only `shopMoney`, `presentment` mode only `presentmentMoney`, which keeps the
  query cheaper.

### Cost

The docs say a query's cost is calculated, the bucket refills at a plan-dependent rate, and one query may not exceed
1,000 points. The exact formula and the bucket sizes were not on the pages read. The mock therefore uses a **toy
model**: an object costs 1 and a connection costs `1 + first × (1 + cost of the children)`, charged against a
bucket (default 1,000, restoring 100 per second) and refunded down to the actual cost afterwards. That is enough to
make throttling, pacing and `MAX_COST_EXCEEDED` testable. It is not Shopify's cost. Because nested `first` values
multiply, the default page is **2 orders** with the default nested limits; on a real store, read
`extensions.cost` from a real response and tune `pageSize` and the limits (checklist section 4).

## 4. Sales aggregation and reconciliation

`aggregateSales(orders, options)` turns Admin API order objects into rows per local day and currency. All
arithmetic is on **integer minor units** (decimal strings are parsed without floats, using an ISO 4217 exponent
table: JPY has 0 decimals, 3-decimal currencies such as BHD are handled). Metric names and meanings follow the
ShopifyQL `sales` schema:

| Metric | Meaning here |
|---|---|
| `orders` | orders counted once, on their date |
| `gross_sales` | line items before discounts and returns; no tax, shipping or fees |
| `discounts` | discounts on those line items |
| `net_sales_reversals` | value of refunded items after discounts, before tax |
| `net_sales` | `gross_sales - discounts - net_sales_reversals` |
| `shipping_charges`, `shipping_reversals` | shipping after shipping discounts and before tax; shipping refunded |
| `taxes`, `tax_reversals` | tax charged; tax refunded |
| `other_refunds` | refund money that is neither item, shipping nor tax (this kit's own metric) |
| `total_sales` | `net_sales + shipping_charges - shipping_reversals + taxes - tax_reversals - other_refunds` |

* **Attribution.** "Each row records one event": the sale lands on the order's date (`processedAt` by default,
  `createdAt` optional), every refund on the refund's own `processedAt` date. A refund in November of an October
  order reduces November, not October.
* **Time zones.** Days are local days in the shop's IANA zone, computed with `Intl`, so DST days of 23 and 25 hours
  and the repeated hour are correct. A fixed UTC offset or UTC would put orders on the wrong day; the tests show
  that these choices make the reconciliation fail.
* **Currencies.** `shop` mode uses `shopMoney` (what Shopify's reports show), `presentment` mode keeps one bucket
  per customer currency. No conversion is done and presentment amounts are never added to shop amounts.
* **Exclusions (policy, documented).** Test orders and cancelled orders are excluded entirely, with their refunds.
  Refunds whose money movement failed are ignored.
* **Refusals.** Orders with taxes included in prices, gift-card line items, amounts in the wrong currency, subtotal
  or total that the parts do not explain, and refunds that cannot be explained are errors in the default strict
  mode (`AggregationError` lists the issue per order). With `strict: false` the order is skipped and reported.

`reconcile(result, report)` compares every metric of every day and currency, plus the totals, to the minor unit with
zero tolerance and returns each difference with its direction and size. `npm run reconcile` runs it on the shipped
fixtures; `--via-mock` first fetches the orders through the client and the mock.

### The "Shopify report" fixture was not exported from Shopify

`fixtures/shopify-report.shop.json` and `fixtures/shopify-report.presentment.json` are **hand-written** from the
published metric definitions. They were **not exported from a real store**, and they are not a Shopify report: the
author has no store. Every figure was worked out on paper from the order specs, independently of `src/aggregate.ts`
(each row carries its derivation), and then typed in. What reconciling to them proves: the code implements those
definitions without arithmetic slips, on ten orders chosen to hit the awkward cases. What it cannot prove: that
Shopify's own report applies the same definitions (see Limits).

The window is 2026-10-29 to 2026-11-03 in `America/Toronto`. Of the 10 fixture orders: #1005 is a test order and
#1006 is cancelled; #1003 is partly refunded, with a refund whose UTC date (Nov 2) is the day after its local date
(Nov 1); #1004 is refunded in full (items and shipping); #1008 has a shipping-only refund; #1009 was sold on Oct 28,
before the window, and refunded inside it; #1002 (USD), #1007 (JPY) and #1008 (GBP) are not in CAD; #1002 is placed
at 23:30 local on Oct 30, which is already Oct 31 in UTC, and #1007 exactly at local midnight on Nov 2. Shop-currency
result: 7 orders, gross 511.50, discounts
31.25, item reversals 159.50, net 320.75, shipping 50.00 (16.00 reversed), taxes 68.94 (22.82 reversed), total 400.87.

The report format, if you want to reconcile your own export:

```json
{
  "shop": { "currency": "CAD", "timeZone": "America/Toronto" },
  "rows": [ { "day": "2026-10-30", "currency": "CAD", "orders": 2, "gross_sales": "78.50", "discounts": "3.00",
              "net_sales_reversals": "0.00", "net_sales": "75.50", "shipping_charges": "14.00",
              "shipping_reversals": "0.00", "taxes": "11.64", "tax_reversals": "0.00", "other_refunds": "0.00",
              "total_sales": "101.14" } ],
  "totals": { "CAD": { "orders": 7, "gross_sales": "511.50" } }
}
```

Amounts are decimal **strings** (numbers hide trailing zeros and invite float errors); `orders` is an integer.

## 5. Theme fixes with the real theme-check

`theme/before` is a small Online Store 2.0 style theme with five deliberate problems. `scripts/theme-check.mjs`
runs `@shopify/theme-check-node` 3.31.0 from npm (a dev dependency) on a folder; nothing is simulated, the output
is theme-check's own. Real output on `theme/before`, saved in `theme/results/before.txt`:

```
layout/theme.liquid:13:5  error   ParserBlockingScript  Avoid parser blocking scripts by adding `defer` or `async` on this tag
sections/product-main.liquid:4:45  warning UndefinedObject  Unknown object 'prodcut' used.
snippets/price.liquid:5:3  warning UnusedAssign  The variable 'sale_label' is assigned but not used
snippets/product-card.liquid:4:7  error   ImgWidthAndHeight  Missing width and height attributes on img tag
snippets/product-card.liquid:14:15  error   MissingTemplate  'snippets/product-badge.liquid' does not exist
5 offense(s) in 10 files: 3 error, 2 warning, 0 info
```

Fixes in `theme/after` (diff the two folders): `defer` on the script tag, the typo `prodcut` corrected, the unused
`assign` removed, `width`/`height` added to the image, and the missing `snippets/product-badge.liquid` created.
Output on `theme/after`: `0 offenses in 11 files`.

Limits of this part: runs used `--offline` (the Liquid reference bundled in the npm package, revision recorded in the
output) so that results do not depend on what shopify.dev serves today; the mode that fetches current docs was not
exercised. Severities are what the tool printed, not what the docs table lists. A clean run means no offenses of the
`recommended` checks, not that the theme looks right or is fast.

## Tests

`npm test` runs **467 tests in 17 files** with Vitest (at most 2 workers, about 4 seconds). They include: the primitives, every
rejection path of the install flow, the receiver with real signed bodies, concurrency of the dedupe store, a real
`node:http` server, the client against the mock with scripted faults (throttle, partial, 5xx, malformed JSON,
dropped connection, revoked token), pagination edge cases, and the reconciliation including **sensitivity tests**:
changing any one of the 209 report values by one minor unit produces exactly one difference, and using UTC days, a
fixed offset, `createdAt`, counting test or cancelled orders, or the wrong money side each fails the reconciliation.
A fixture-drift test regenerates `fixtures/orders.json` from the specs and compares. The theme tests run the real
theme-check on both folders.

## Mutation check

`node scripts/mutation-check.mjs` copies the project to a throwaway folder, breaks the source in one of
73 documented ways at a time (flipped comparisons, a removed check, a wrong constant, a swapped field), and runs the
whole suite against each copy. A mutant counts as *killed* only if a test file that failed fails again on its own, by
assertion. Each run has a hard timeout; on timeout the whole process tree (the runner, its workers and anything they
started) is killed, and a timed-out mutant is reported as `TIMEOUT`, which is **not** a kill. `--selftest` plants an
endless loop in a test file and checks that the timeout fires, that no process is left, and that it takes less than
40 seconds. `--validate` checks that every mutant still applies to the current source.

**Result (2026-11-01, Node 26.13.0, one mutant at a time): 73 of 73 mutants killed**, none timed out, no stray
process left behind; the selftest reports `timedOut=true leftoverProcesses=0 elapsed=15s`. The full table, with the
test that failed first and how many tests and files noticed each mutant, is in
[docs/MUTATION-RESULTS.md](docs/MUTATION-RESULTS.md). The mutants cover the HMAC and shop-domain checks, every
install-flow validation, the dedupe store, the receiver's status codes, the compliance erasure, out-of-order
handling, the client's retry, pacing and version rules, pagination guards, the aggregator's date, currency,
exclusion and cross-check rules, and the reconciliation tolerance.

What to make of the number:

* **It was not 73 of 73 the first time.** The first complete run killed 71 and two survived. Neither was an
  equivalent mutant; both were real gaps. (1) `customers/redact` cleared an order named in `orders_to_redact` only
  through a lookup by customer id, and no test had an order with an email but no matching customer id. (2) No
  test contained a shipping line with `isRemoved: true`. A test was added for each, and the re-run killed both.
* **The mutants are 73 hand-picked single-text swaps**, not the output of a mutation tool that enumerates every
  possible change. A full kill rate on a hand-picked list says the tests are sensitive to these failures; it does
  not say that no bug remains.
* **27 of the 73 are caught by exactly one test** (listed at the end of the results file), usually a test written
  for that one check. The mean is 4.3 failing tests per mutant. A single guard test is normal for a single check, but
  it is also where a refactor of the test would lose coverage.
* **One kill is by a source-level guard.** M01 swaps `timingSafeEqual` for `Buffer.equals`, which behaves
  identically; only a test that reads the source can notice. That is the documented limit of testing timing.
* Running the selftest and baseline repeatedly also exposed a flaky test (an intermittent `ECONNRESET` in
  `server.test.ts`: it failed in roughly a quarter to a half of the runs I measured under load). The cause was two test servers in a row binding the same
  port while `fetch` reused the first one's pooled connection. `testing/ports.ts` now rotates ports; the file passed
  30 of 30 runs afterwards.

## Limits

Where the documentation was silent or ambiguous, the kit made a choice. A different choice would change numbers.

1. **Which date places an order on a day.** The docs read do not say whether Shopify's reports use `processedAt` or
   `createdAt`. Default here: `processedAt` (also the default sort of the `orders` query); `createdAt` is an option.
2. **Item reversals.** The `net_sales` formula says "sales reversals"; this kit subtracts the refunded item value
   after discounts (`net_sales_reversals`). It also assumes `RefundLineItem.subtotalSet` is the item value after
   discounts.
3. **`total_sales`** is computed with shipping and tax net of their reversals, so a fully refunded order totals 0.
   Whether a real report nets them the same way was not confirmed.
4. **Hand-written report.** The reconciliation target was written from the definitions by the same author as the
   code. It checks arithmetic and attribution consistency, not agreement with Shopify.
5. **Out of scope orders.** Orders with taxes included in prices and orders with gift-card line items are refused;
   duties, fees, tips and store credit are not modelled. `other_refunds` is this kit's own bucket.
6. **Cancelled and test orders** are excluded by policy. ShopifyQL keeps cancelled orders and has an
   `is_canceled_order` dimension; excluding them equals filtering on that dimension.
7. **Toy cost model** in the mock (see Cost). Real costs, bucket sizes and error texts were not observed.
8. **Nested lists.** Refunds have no `pageInfo`, so a list that reaches its `first` limit may be truncated and the
   fetch fails; line items and shipping lines are checked with `hasNextPage`.
9. **Refunds the parts do not explain.** A refund whose total is not the sum of its item, shipping and tax lines is an
   error in strict mode (`REFUND_TOTAL_MISMATCH`) unless an order adjustment accounts for the difference, in which
   case the difference is reported as `other_refunds` with a warning. If `currentTotalPriceSet` differs from the
   order total minus the itemised refunds, a `CURRENT_TOTAL_DIFFERS` warning is raised, because the docs say only
   "after returns" and a refund without returned items is one possible cause.
10. **60-day window.** `read_orders` covers the last 60 days; older orders need `read_all_orders`, which needs
    approval.
11. **Cancellation is permanent** in the handlers; the docs read do not say otherwise.
12. **No maximum webhook payload size** was found in the docs; the server's default limit is 5 MiB.
13. **theme-check offline only**, as described above.
14. **Docs versions.** Everything is from the API 2026-10 pages as read on 2026-11-01. Re-read before relying on a detail.
15. **Constant-time comparison** is used, but a unit test cannot prove timing behaviour. A source-level test only
    checks that the comparison function is `timingSafeEqual`.

## What this does not prove

* That any of it works against Shopify. A mock encodes the author's reading of the docs; if the reading is wrong, the
  mock and the code are wrong together and the tests still pass.
* That the numbers equal Shopify's reports. See the hand-written report above.
* That the kit is ready for production: tokens are stored unencrypted, token refresh has no scheduler, storage is one
  SQLite file, and there is no queue. See [docs/NOT-COVERED.md](docs/NOT-COVERED.md).
* That the tests find every bug. A kill rate of the mutation check is a statement about the listed mutants only.
* That the theme looks right in a browser or performs well.
* That an app built from these parts passes App Store review.

## Docs

* [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md): local run, then the path to a development store
* [docs/GO-LIVE-CHECKLIST.md](docs/GO-LIVE-CHECKLIST.md): what to confirm on a real store, blank on purpose
* [docs/NOT-COVERED.md](docs/NOT-COVERED.md): everything this kit does not do or prove
* [docs/SOURCES.md](docs/SOURCES.md): every page read, with the date

## License

MIT, see [LICENSE](LICENSE).
