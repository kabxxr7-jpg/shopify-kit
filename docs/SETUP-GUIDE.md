# Setup guide

Two parts. **Part A** runs everything on your own machine against the local mock and is what the test suite
exercises. **Part B** is the path to a real development store. Part B has **not been run by the author**: there
was no Shopify account to run it with. It is assembled from the pages in [SOURCES.md](SOURCES.md), so treat every
step as "documented, not yet confirmed" and record what you find in [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md).

## Part A: run it locally (no Shopify account needed)

Requirements: Node 25 or newer (the code uses `node:sqlite` and runs `.ts` files directly) and npm.

```sh
git clone <this repository> shopify-kit && cd shopify-kit
npm ci
npm test                      # the whole suite, including the theme-check runs
npm run typecheck
```

### The app server with a fictional secret and a mock Shopify

```sh
npm run serve -- --demo       # picks a free port in 4770-4789 and prints it
```

The demo uses a fictional client secret (`test_client_secret_not_real_...` in `testing/sign.ts`), an in-memory
database and a mock Shopify that answers the OAuth token request and the Admin GraphQL endpoint with fixture
orders. Use the printed port in place of `4770` below.

Send a signed webhook (the signature is computed with the demo secret, over the exact bytes sent):

```sh
BODY='{"id":820982911946154508,"updated_at":"2026-11-02T10:00:00-05:00","name":"#1001","cancelled_at":null}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'test_client_secret_not_real_0123456789' -binary | base64)
curl -i -X POST http://127.0.0.1:4770/webhooks \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Topic: orders/updated" \
  -H "X-Shopify-Shop-Domain: harbour-pine-demo.myshopify.com" \
  -H "X-Shopify-Webhook-Id: 11111111-1111-4111-8111-111111111111" \
  -H "X-Shopify-Hmac-SHA256: $SIG" \
  --data-binary "$BODY"
```

Expected: `200`. Send the same request again: `200` with `"status":"duplicate"`. Change one character of the body
without recomputing the signature: `401`.

### Reconcile the dashboard numbers

```sh
npm run reconcile                       # shop currency, fixtures/orders.json vs the hand-written report
npm run reconcile -- --mode presentment # one bucket per customer currency
npm run reconcile -- --via-mock         # fetch the same orders through the mock Admin API first
```

Exit code 0 means every metric of every day and currency matches to the minor unit; 1 prints each difference.
The report file is written by hand from Shopify's published metric definitions. It is not an export from a store
(see the README, "Limits").

### Run the real theme-check on the sample theme

```sh
npm run theme:check -- theme/before --offline   # 5 offenses
npm run theme:check -- theme/after  --offline   # 0 offenses
```

`--offline` makes theme-check use the Liquid reference docs bundled in the npm package, so the result does not
depend on what shopify.dev serves today. Without `--offline` theme-check may download the current docs; that mode
was not exercised for the committed results.

## Part B: take it to a development store (not yet done)

### 1. Accounts and a store

* You need a Shopify Partner account, or a merchant store with developer permissions, and the permission to
  create development stores in your organization. Source: "Dev stores".
* Create a development store with the Dev Dashboard (Stores, Create store, Dev) or with the CLI:

  ```sh
  shopify store create dev --name "Harbour test" --plan basic --demo-data --country CA
  ```

  The `myshopify.com` URL cannot be changed afterwards. Before creating orders, look at the store's time zone and
  currency in its settings: the reconciliation uses the shop's `ianaTimezone` and currency, and the kit reads them
  from the API (`fetchShopInfo`) instead of assuming them.
* To check the presentment-currency mode you need orders placed in a second currency. How to enable one is not
  covered by the pages this kit was built from; use Shopify's own help for the store settings involved.

### 2. Create the app

* In the Dev Dashboard create an app. Note the **client ID** and **client secret** (they are the `SHOPIFY_API_KEY`
  and `SHOPIFY_API_SECRET` below). Keep the secret out of git and out of logs.
* Add the redirect URL `https://<your-tunnel-host>/auth/callback` to the app settings. It must match the
  `redirect_uri` this kit sends **exactly**, and the kit never takes the redirect URI from the request.
* Scopes: `read_orders` is enough for the orders client and the order webhooks. It covers orders from the last
  60 days. To read older orders you must also request `read_all_orders`, which needs Shopify's approval, and add it
  to `scopes` in `scripts/serve.ts` (or your own wiring).
* If you manage the app with the CLI, `shopify.app.toml` carries the same information. The shape below is adapted
  from the sample in "App configuration" and has not been deployed:

  ```toml
  client_id = "<client id>"
  application_url = "https://<your-tunnel-host>"
  embedded = false

  [access_scopes]
  scopes = "read_orders"

  [auth]
  redirect_urls = ["https://<your-tunnel-host>/auth/callback"]

  [webhooks]
  api_version = "2026-10"

  [[webhooks.subscriptions]]
  topics = ["orders/create", "orders/updated", "orders/paid", "orders/cancelled", "refunds/create", "app/uninstalled"]
  uri = "/webhooks"

  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "/webhooks"
  ```

  Whether those two subscription blocks may share one `uri`, or must be merged, is for the CLI's validator to
  say. If it complains, merge them as the sample in the docs does.
* If you are building a **CLI-scaffolded app**, Shopify uses managed installation and you do not run an OAuth
  flow at all; use only the webhook, client and aggregator parts of this kit. The OAuth module is for standalone
  or API-only apps with their own backend.

### 3. Run the server in front of a tunnel

```sh
export SHOPIFY_API_KEY=...        # client ID
export SHOPIFY_API_SECRET=...     # client secret
export APP_URL=https://<your-tunnel-host>
npm run serve                     # database file at data/shopify-kit.db (git-ignored)
```

Any HTTPS tunnel will do. The server prints the install and webhook URLs. It listens on a free port in 4770-4789.

### 4. Install and check

1. Open `https://<your-tunnel-host>/auth/install?shop=<store>.myshopify.com` in a browser that is logged in to
   the store admin. Approve the scopes.
2. Check that a row appeared in `shops` (`sqlite3 data/shopify-kit.db 'select shop_domain, scope, installed_at from shops'`)
   and that the granted `scope` covers what you asked for. The kit refuses to store a token whose granted scopes are
   narrower than requested.
3. Trigger webhooks the way the docs recommend for an end-to-end check: perform the action in the admin (create
   an order, refund it) rather than only using `shopify app webhook trigger`, whose payload is always the same
   and which is not retried on failure.
4. In `processed_webhooks` every delivery should be `done`. A `failed` row means your handler threw and Shopify
   will retry.
5. Uninstall the app and check that the `app/uninstalled` handler removed the token. `shop/redact` arrives 48 hours
   later, so test it with a sample delivery rather than waiting.

### 5. Fetch orders and reconcile against Shopify's own report

1. Create a handful of orders in the store that cover: a discount, shipping, tax, a partial refund, a full refund,
   a cancelled order, a test order (one placed through a gateway in test mode), and, if you have one, a
   foreign-currency order. Place one just before and one just after local midnight.
2. Open Shopify's own sales report in the store admin for the same date range and time zone and export the numbers.
   (The Help Center pages for the report were not read when this kit was built, so the report's name, columns and
   export format are unconfirmed; compare against the metric names in the README table.)
3. Convert those numbers to the report JSON shape described in the README and run
   `npm run reconcile -- --orders <your orders json> --report <your report json> --tz <shop zone> --from <day> --until <day>`.
   (Fetching live orders into the orders JSON uses `fetchAllOrders` from `src/orders.ts` with an `AdminClient`.)
4. Any difference is information about this kit's interpretation (see README, "Limits": which date places an order on
   a day, how reversals are netted). Fix the interpretation in `src/aggregate.ts`, keep the old behaviour in a test,
   and write down what the store showed in the checklist.
