# Go-live checklist

Use this before pointing the kit at a real store, and again before pointing it at a production store. Every box
is **unchecked on purpose**: nothing here has been run against Shopify. The kit was developed against a local mock
and fixtures written from the public docs, so each item is a place where the mock and the real service could
disagree.

```
Ran on a development store on: ____-__-__        (not yet run)
Store (myshopify.com):          ______________________
API version actually answering: ______________________   (X-Shopify-API-Version of a real response)
Done by:                        ______________________
Kit commit:                     ______________________
```

An item is done when you can write down what you saw (a status code, a row, a number) in the "evidence" column of
your own copy. "It looked fine" is not evidence.

## 1. Credentials and configuration

- [ ] Client ID and client secret come from environment variables or a secrets manager, never from the repository.
- [ ] `git log -p` and the deployed image contain no `shpat_`, `shpss_` or client-secret value.
- [ ] The redirect URL in the app settings equals `APP_URL + /auth/callback` character for character.
- [ ] `APP_URL` is HTTPS and is the address Shopify can actually reach.
- [ ] The requested scopes are the smallest set that works (`read_orders` for the orders client). If orders older
      than 60 days are needed, `read_all_orders` has been requested **and approved**.
- [ ] After a rotation of the client secret, both the old and the new secret are accepted for webhooks until the
      rotation has propagated (`secrets: [new, old]`), then the old one is removed.

## 2. Install flow

- [ ] Installing from a valid `?shop=` works and stores one row in `shops`.
- [ ] `?shop=` with a host that is not `*.myshopify.com` (for example `evil.example`, or
      `x.myshopify.com.evil.example`) is refused with 400 and no redirect to that host is issued.
- [ ] Opening the callback URL with a tampered `hmac`, a missing `state`, a `state` from another browser, or a
      `state` that was already used is refused (403).
- [ ] Declining a scope on the approval screen (if the screen allows it) leads to a refused callback, not to a
      stored token with fewer permissions.
- [ ] The token request is sent with `expiring=1`; the response contains a refresh token; the stored
      `expires_at` is plausible.
- [ ] **Refresh works on a real store.** Force the access token to expire (or wait), call
      `refreshAccessToken`, store the new refresh token before using the new access token, and confirm the old
      refresh token is no longer accepted. The kit contains no scheduler for this.
- [ ] Uninstalling removes the token (`app/uninstalled`), and an Admin API call with the old token fails with an
      authorisation error. The client is written to throw `AuthError` at once on HTTP 401 or `ACCESS_DENIED` and not
      retry; confirm that this is what a real revoked token produces.

## 3. Webhooks

- [ ] The proxy or tunnel in front of the server forwards the **raw bytes** of the body. Send a real delivery and
      confirm the HMAC check passes. (Compression, re-encoding or JSON re-serialisation in front of the app
      breaks the signature.)
- [ ] A delivery with a wrong signature gets 401; with a missing signature 401; with a valid signature and a
      non-JSON body 400. (Shopify counts any non-2xx answer as a failed delivery and retries it, so a malformed
      body that Shopify itself sent would be retried; check how often that happens in the logs.)
- [ ] The response time of a real delivery, including the database write, is far below the 5 seconds Shopify
      allows. Measure it; note the 95th percentile.
- [ ] `orders/create`, `orders/updated`, `orders/paid`, `orders/cancelled` and `refunds/create` each produce the
      expected row. Compare the stored values with the order as shown in the admin.
- [ ] Make the handler fail once (for example stop the database), watch Shopify retry, and confirm the delivery
      ends as `done` exactly once. Check what Shopify does after repeated failures.
- [ ] Duplicate delivery: replay the same `X-Shopify-Webhook-Id` and confirm 200 and no second effect. Two
      subscriptions for the same topic (different webhook ids, same event id) are both processed or the second is
      deliberately skipped, whichever you decided, and you wrote the decision down.
- [ ] Out-of-order delivery: replay an older `orders/updated` after a newer one and confirm the newer data stays.
- [ ] Order ids in real payloads are stored as text and match the ids in the admin. Check one id above
      9,007,199,254,740,991 if the store has any.
- [ ] All three compliance topics are subscribed in the app configuration. Send a sample of each. Confirm that an
      invalid signature gets 401 and that a valid one gets 2xx and a row in `compliance_requests` with a due date.
- [ ] Someone owns the 30-day clock: the `compliance_requests` rows with `status = 'received'` are reviewed on a
      schedule. `customers/data_request` is **not** answered automatically by this kit; the data must reach the
      merchant by a route you decide.
- [ ] The kit's erasure covers the data *your deployment* stores. If you added tables or logs with customer data,
      the redact handlers cover them too.

## 4. Admin API client

- [ ] A request with the pinned version (2026-10 by default) is answered by that version
      (`X-Shopify-API-Version`). Turn on `strictVersion` once you have seen this, so a fall-forward becomes an
      error instead of a silent change.
- [ ] Put a calendar reminder for the end of the pinned version's support window.
- [ ] Look at a real `extensions.cost` block. Write down `maximumAvailable` and `restoreRate` for the store's
      plan, and `requestedQueryCost` and `actualQueryCost` for one orders page.
- [ ] Compare those numbers with the mock's toy cost model. Adjust `pageSize` and the nested `limits` so a page
      stays well under the 1,000 point single-query limit; the kit halves the page size on `MAX_COST_EXCEEDED`,
      confirm that this really happens with the real error.
- [ ] Provoke `THROTTLED` (run several fetches in parallel) and confirm the shape of the real error matches what
      the client expects (HTTP 200, `errors[].extensions.code = "THROTTLED"`), and that the client's wait is
      sensible.
- [ ] Fetch more than one page of orders and confirm no order is missing or doubled, compared with the order
      count shown in the admin for the same filter.
- [ ] If any order has more line items, shipping lines or refunds than the nested limits, the fetch stops with an
      error. Raise the limits and confirm it then succeeds.
- [ ] For a history longer than the pagination cap (25,000 objects), switch to date-window fetching or to bulk
      operations; the kit refuses rather than truncating.

## 5. Sales numbers

Do this on a store with at least a few days of varied orders (see the Setup guide, step 5).

- [ ] Compare **every** metric for **every** day and currency with Shopify's own report. Zero difference is the
      goal; each difference is written down with the order it comes from.
- [ ] Which timestamp does Shopify's report use to place an order on a day: `processedAt` or `createdAt`? Test with
      an order whose two timestamps fall on different days. Set `dateField` accordingly.
- [ ] Is `net_sales` after discounts, and how are reversals measured? Check an order with a discount and a
      partial refund.
- [ ] Is `total_sales` in Shopify's report net of shipping and tax reversals, as the kit assumes?
- [ ] Day boundaries: an order just after local midnight lands on the new local day; a refund processed after
      midnight lands on the refund's day.
- [ ] The shop time zone is read from the API, not hard-coded.
- [ ] Test orders and cancelled orders: the kit excludes both. Decide whether that is what the client's number
      should do and say so in the dashboard's labels.
- [ ] Orders with taxes included in the prices, gift-card line items, duties, tips and additional fees: the kit
      refuses or only approximates these. Find out whether the store has any before promising a reconciled
      number.
- [ ] Multi-currency: in shop-currency mode totals match the shop-currency report; in presentment mode each
      currency matches its own bucket. No currency conversion is performed or implied.

## 6. Operations

- [ ] The access token column is encrypted at rest or moved to a secrets store. The kit stores it in clear text in
      SQLite.
- [ ] Database backups exist and a restore has been tried.
- [ ] Logs contain no payloads, tokens, secrets or customer data (the kit's own request log does not).
- [ ] Alerts exist for: rows in `processed_webhooks` stuck in `in_flight` or `failed`, compliance rows past their
      due date, repeated `THROTTLED`, a changed `X-Shopify-API-Version`.
- [ ] The service is restarted during a webhook burst; no delivery is lost and none is processed twice.
- [ ] Only one process writes the SQLite file, or the store has been replaced with one that supports concurrent
      writers.
- [ ] The server is behind HTTPS with a request size limit and a timeout.
- [ ] A runbook says who gets paged and what to check first.

## 7. Theme (if the job includes a theme)

- [ ] `theme-check` runs **without** `--offline` against the client's theme and its result is saved. (The
      committed results were produced in offline mode only.)
- [ ] The theme is previewed in a development theme or on a development store, not edited live.
- [ ] Every fix is confirmed in the storefront by looking at it, not only by a clean theme-check run: theme-check
      finds categories of mistakes, it does not prove that the page looks right or loads fast.
- [ ] Anything theme-check cannot see (performance on a real device, accessibility, apps injecting scripts) has
      been looked at separately or is listed as not covered.

## 8. Sign-off

- [ ] Every item above is checked **or** has a written reason why it does not apply.
- [ ] The README's "Limits" section has been re-read and each limit is either removed by a test against the real
      store or repeated to the client.
- [ ] The date, store and API version at the top of this file are filled in. Until then this kit has never run on
      Shopify, and nothing it says about Shopify's behaviour should be presented as tested there.
