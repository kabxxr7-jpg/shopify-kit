# Not covered

A list of what this kit does not do, does not prove, or only approximates. It exists so that nobody reads a green
test run as a statement about Shopify. The README's "Limits" section carries the interpretations of the docs that
change numbers; this file is the wider list.

## It has never run on Shopify

* No Shopify Partner account or development store was available. Every test runs against a mock Admin API and
  fixtures written from Shopify's public documentation (see [SOURCES.md](SOURCES.md)).
* A mock encodes the author's reading of the docs. If the docs were misread, the mock and the code are wrong in
  the same way and the tests still pass. That is the main thing a first run on a development store is for.
* The "Shopify report" used for reconciliation was written by hand from the published metric definitions. It was
  not exported from a store. A match proves the aggregator agrees with the author's understanding of those
  definitions, not with Shopify's implementation.
* The mock's query-cost model is a toy. Real costs, bucket sizes per plan and error texts were not observed.
* theme-check was run in `--offline` mode against the Liquid reference bundled in the npm package. The mode that
  fetches the current reference was not exercised.

## App types and platform features that are out of scope

* Embedded apps: App Bridge, Polaris, session tokens, token exchange and managed installation. The OAuth module
  is the authorization-code flow for standalone or API-only apps.
* App Store submission, app review, billing (subscriptions, usage charges), the review checklist.
* Protected customer data approval. The kit records compliance requests and erases its own copy of the data; it does
  not request or prove access to protected data.
* Webhook delivery through Amazon EventBridge or Google Cloud Pub/Sub; webhook filtering and `include_fields`;
  creating subscriptions through the API (the setup guide uses app configuration instead).
* Bulk operations. A fetch that would cross the 25,000-object pagination cap is refused, not split.
* The REST Admin API, the Storefront API, the Customer Account API, Shopify Functions, checkout and theme app
  extensions, Hydrogen, POS, B2B, Markets management.
* Draft orders, order edits, returns and exchanges as workflows. Refunds are read, but only as the objects the
  Admin API returns for an order.

## Sales aggregation limits

* Orders whose prices include tax, and orders with gift-card line items, are refused (an error in strict mode,
  reported and skipped otherwise). They are not approximated.
* Duties, additional fees, tips and store credit are not modelled. Refund money that is not item, shipping or tax is
  reported as a separate `other_refunds` figure; that metric belongs to this kit, not to Shopify.
* No currency conversion. Shop-currency totals use the shop-currency amounts Shopify returns; presentment-currency
  totals are kept per currency and never added together.
* Cancelled and test orders are excluded by policy. Shopify's own reports may count cancelled orders and let the
  user filter them out; the kit's choice is documented, not Shopify's behaviour.
* Reports are compared for the days and currencies in the window only. Anything outside it is ignored.
* Refunds are placed on the day they were processed, and orders on `processedAt` by default. Which date Shopify's
  report uses was not confirmed (README "Limits").
* Only the nested lists the query asks for are covered: line items, shipping lines, refunds and their parts, up to
  the configured limits. An order that exceeds a limit stops the fetch.

## Webhooks and install flow limits

* Access tokens are stored **unencrypted** in SQLite. A real deployment needs encryption at rest or a secrets
  store.
* Refresh of expiring tokens is implemented as a function (`refreshAccessToken`) and tested against the mock. There is
  no scheduler that calls it, no concurrency control around it (two processes could rotate the same refresh token),
  and the rotation was never observed on a real store.
* `customers/data_request` is recorded and acknowledged. Producing the data and delivering it to the merchant is
  left to the deployment.
* Storage is SQLite on one machine. There is no multi-node locking, queue, dead-letter store or replay tool.
* Webhook payloads are the REST-shaped JSON from the docs' sample payloads. Fields Shopify may add are ignored.
* The receiver finishes the database write before answering. Slow handlers must be moved behind a queue by whoever
  deploys this; the 5-second limit is not enforced by the code, only documented.
* No rate limiting, IP allow-listing or authentication on the endpoints other than the HMAC and OAuth checks.
* Constant-time comparison is used and a source-level test guards against it being replaced, but timing behaviour
  cannot be proved by a unit test.

## Theme limits

* One small sample theme with five planted problems, checked by theme-check. This shows how theme-check findings are
  found and fixed, not that a real theme is correct.
* Not covered: the visual result in a browser, performance on a real device, accessibility testing, theme editor
  behaviour, translations beyond what theme-check validates, apps that inject scripts, deployment to a live theme.
* A clean theme-check run means no offenses of the checks in the `recommended` set were found. It is not a quality
  guarantee.

## Testing limits

* The mutation check breaks the source in a fixed list of ways and counts how many the tests notice. A high kill rate
  says the tests are sensitive to those changes, not that no bug remains. Equivalent mutants (changes that do not
  alter behaviour) are labelled as such in the results.
* No load, soak or chaos testing; no test against slow or malicious clients beyond the body-size limit and
  malformed input cases that are in the suite.
* Day boundaries are tested for America/Toronto (both 2026 DST changes, including the repeated hour), Asia/Kolkata
  (half-hour offset, no DST) and UTC. Other zones, the Southern Hemisphere and zones that skip a calendar day were
  not tested.
