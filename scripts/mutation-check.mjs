// Mutation check: break the source on purpose, run the test suite against each broken copy, and report how many
// breakages the tests notice. Mutants run in copies under .mutation-work/ (git-ignored), never in the real tree.
//
//   node scripts/mutation-check.mjs [--only <id,id>] [--keep] [--timeout-min 4] [--write docs/MUTATION-RESULTS.md]
//   node scripts/mutation-check.mjs --validate     (checks every mutant still applies to the source, runs no tests)
//   node scripts/mutation-check.mjs --selftest     (proves the timeout kills a hanging run and leaves no process behind)
//
// One mutant at a time (concurrency 1). The whole suite runs for each mutant (no --bail), so the table can say how
// many tests and test files noticed it; a mutant noticed by a single test is thin coverage and is flagged. Every test run has a hard timeout; on timeout the whole process tree is
// killed (vitest, its workers, anything they started, and the process group) and the mutant is reported as TIMEOUT,
// which is NOT a kill, unless a test file that had already failed fails again on its own.
//
// A mutant counts as killed only if the failing test file fails again on its own, by assertion (re-confirmed).
// Exit code: 0 when every mutant was killed, 1 when at least one survived, timed out or was inconclusive.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".mutation-work");
const COPY = ["src", "test", "testing", "scripts", "fixtures", "theme", "docs", "README.md", "LICENSE", "package.json", "tsconfig.json", "vitest.config.ts"];

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const ONLY = opt("--only", "")?.split(",").filter(Boolean) ?? [];
const KEEP = args.includes("--keep");
const SELFTEST = args.includes("--selftest");
const VALIDATE = args.includes("--validate");
const WRITE = opt("--write", "");
const RUN_TIMEOUT_MS = Number(opt("--timeout-min", "4")) * 60_000;
const CONFIRM_TIMEOUT_MS = Math.min(RUN_TIMEOUT_MS, 2 * 60_000);

/** `find` must occur exactly once in the file, or the script stops (a stale mutant would count as a fake kill or survivor). */
const swap = (id, desc, file, find, replace, note = "") => ({ id, desc, file, note, apply: (text) => {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`mutant ${id}: expected exactly 1 match for ${JSON.stringify(find)} in ${file}, found ${n}`);
  return text.replace(find, () => replace);
} });
const GUARD = "behaviour-neutral; caught only by the source-level guard test";

const MUTANTS = [
  // ---- HMAC, shop domain
  swap("M01-hmac-plain-compare", "webhook HMAC compared with Buffer.equals instead of timingSafeEqual", "src/hmac.ts", "if (timingSafeEqual(expected, candidate)) matched = true;", "if (expected.equals(candidate)) matched = true;", GUARD),
  swap("M02-hmac-first-secret-only", "rotation: only the first secret is tried", "src/hmac.ts", "for (const secret of secrets) {", "for (const secret of secrets.slice(0, 1)) {"),
  swap("M03-hmac-format-guard-removed", "a malformed base64 header is no longer rejected before the comparison", "src/hmac.ts", 'if (typeof header !== "string" || !BASE64_SHA256.test(header)) return false;', 'if (typeof header !== "string") return false;'),
  swap("M04-oauth-message-unsorted", "OAuth query parameters are not sorted before signing", "src/hmac.ts", ".sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))", ""),
  swap("M05-oauth-message-includes-hmac", "the hmac parameter is signed along with the others", "src/hmac.ts", '.filter(([key]) => key !== "hmac")', ""),
  swap("M06-shop-pattern-unanchored", "shop domain regex loses its end anchor (host suffix attack)", "src/shop.ts", "\\.myshopify\\.com$/;", "\\.myshopify\\.com/;"),
  // ---- money, time zone
  swap("M07-money-rounds-silently", "extra decimals are no longer an error", "src/money.ts", "if (/[1-9]/.test(fraction.slice(exp))) {", "if (false) {"),
  swap("M08-money-sum-overflow-unchecked", "addMinor no longer detects leaving the safe integer range", "src/money.ts", 'if (!Number.isSafeInteger(total)) throw new MoneyError("sum exceeds the safe integer range");', ""),
  swap("M09-money-unknown-currency-is-2", "an unknown currency is assumed to have 2 decimals", "src/money.ts", "if (exp === undefined) throw new MoneyError(", "if (exp === undefined) return 2; void new MoneyError("),
  swap("M10-money-yen-has-cents", "JPY removed from the zero-decimal list", "src/money.ts", '"ISK", "JPY", "KMF"', '"ISK", "KMF"'),
  swap("M11-tz-utc-days", "days are computed in UTC instead of the shop time zone", "src/tz.ts", 'new Intl.DateTimeFormat("en-CA", { timeZone, year', 'new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year'),
  // ---- OAuth
  swap("M12-oauth-shop-unchecked", "the callback no longer validates the shop domain", "src/oauth.ts", 'const shop = field(query, "shop");\n  if (!isValidShopDomain(shop)) return { ok: false, status: 400, reason: "invalid_shop" };', 'const shop = field(query, "shop") as string;'),
  swap("M13-oauth-hmac-skipped", "the callback no longer verifies the query HMAC", "src/oauth.ts", 'if (!verifyOauthHmac(config.clientSecret, query)) return { ok: false, status: 403, reason: "invalid_hmac" };', ""),
  swap("M14-oauth-cookie-not-compared", "the state cookie is no longer compared with the state parameter", "src/oauth.ts", "if (!state || !input.stateCookie || !safeEqualStrings(state, input.stateCookie)) return", "if (!state) return"),
  swap("M15-oauth-nonce-reusable", "a state value can be used more than once", "src/oauth.ts", "entries.delete(nonce); // single use, even when the shop does not match", ""),
  swap("M16-oauth-scopes-unchecked", "granted scopes are no longer compared with the requested ones", "src/oauth.ts", "if (missing.length > 0) return {", "if (missing.length > 99) return {"),
  swap("M17-oauth-write-does-not-cover-read", "a write_x grant no longer satisfies read_x", "src/oauth.ts", "requested.filter((s) => !granted.includes(s) && !(s.startsWith(\"read_\") && granted.includes(`write_${s.slice(5)}`)))", "requested.filter((s) => !granted.includes(s))"),
  swap("M18-oauth-follows-redirects", "the token request follows redirects (would resend the client secret)", "src/oauth.ts", 'redirect: "manual",', 'redirect: "follow",'),
  swap("M19-oauth-not-expiring", "expiring=1 is not sent by default", "src/oauth.ts", 'if (config.expiring ?? true) form["expiring"] = "1";', 'if (config.expiring ?? false) form["expiring"] = "1";'),
  swap("M20-oauth-refresh-401-retries", "a 401 on refresh is treated as retryable instead of 'reauthorize'", "src/oauth.ts", 'if (response.status === 401) return { status: "reauthorize" };', 'if (response.status === 401) return { status: "retry" };'),
  // ---- dedupe, webhooks
  swap("M21-dedupe-memory-lock-never-expires", "memory store never takes over a stale claim", "src/dedupe.ts", 'if (row.status === "failed" || now() - row.lockedAt > lockTimeoutMs) {', 'if (row.status === "failed") {'),
  swap("M22-dedupe-sql-lock-never-expires", "SQLite store never takes over a stale claim", "src/dedupe.ts", "(processed_webhooks.status = 'in_flight' AND processed_webhooks.locked_at < ?)", "(processed_webhooks.status = 'in_flight' AND 0 AND ? IS NOT NULL)"),
  swap("M23-dedupe-fail-undoes-done", "fail() can flip a finished delivery back to failed", "src/dedupe.ts", "WHERE key = ? AND status <> 'done'", "WHERE key = ?"),
  swap("M24-webhook-hmac-skipped", "the receiver no longer verifies the HMAC", "src/webhooks.ts", 'if (!verifyWebhookHmac({ secrets: options.secrets, rawBody, header: hmacHeader })) return reject(401, "invalid_hmac", "hmac_mismatch");', ""),
  swap("M25-webhook-accepts-parsed-body", "an already-parsed body is no longer refused", "src/webhooks.ts", 'if (typeof rawBody !== "string" && !(rawBody instanceof Uint8Array)) {', "if (false) {"),
  swap("M26-webhook-no-dedupe", "a done delivery is processed again", "src/webhooks.ts", 'if (claim === "done") return { status: 200, body: { received: true, status: "duplicate" } };', ""),
  swap("M27-webhook-handler-error-is-200", "a failing handler is answered with 200 (Shopify would not retry)", "src/webhooks.ts", 'return { status: 500, body: { error: "handler_failed" }, reason: "handler_threw", error: text };', 'return { status: 200, body: { error: "handler_failed" }, reason: "handler_threw", error: text };'),
  swap("M28-webhook-claim-not-released", "a failed delivery keeps its claim, so Shopify's retry is stuck", "src/webhooks.ts", "await options.store.fail(key, text);", ""),
  swap("M29-webhook-compliance-not-recorded", "compliance deliveries are executed but never recorded", "src/webhooks.ts", "options.compliance.record(entry);", ""),
  swap("M30-webhook-big-ids-rounded", "payloads are parsed with plain JSON.parse (ids above 2^53 are rounded)", "src/webhooks.ts", "payload = parseJsonKeepingBigIds(text);", "payload = JSON.parse(text);"),
  swap("M31-webhook-event-key-ignores-topic", "event-id dedupe key drops the topic", "src/webhooks.ts", "key = `${eventId}:${topic}`;", "key = eventId;"),
  // ---- compliance, handlers
  swap("M32-compliance-redact-keeps-pii", "customers/redact no longer clears an order that already exists", "src/compliance.ts", "DO UPDATE SET email = NULL, customer_id = NULL, redacted = 1`,", "DO NOTHING`,"),
  swap("M33-compliance-shop-redact-keeps-refunds", "shop/redact leaves the refund rows", "src/compliance.ts", 'DELETE FROM refunds_seen WHERE shop_domain = ?"', 'DELETE FROM refunds_seen WHERE shop_domain = ? AND 0"'),
  swap("M34-compliance-deadline-wrong", "the 30-day deadline becomes 3 days", "src/compliance.ts", "30 * 24 * 60 * 60 * 1000", "3 * 24 * 60 * 60 * 1000"),
  swap("M35-compliance-record-keeps-pii", "the stored redact request keeps the customer's email and phone", "src/compliance.ts", "scrub.run(JSON.stringify(body), entry.webhookId);", ""),
  swap("M36-handlers-stale-event-wins", "an older order event overwrites a newer one", "src/handlers.ts", "if (ms < existing.updated_at_ms) {", "if (false) {"),
  swap("M37-handlers-cancellation-not-sticky", "a later event can un-cancel an order", "src/handlers.ts", "const cancelledAt = existing.cancelled_at ?? incoming.cancelled_at;", "const cancelledAt = incoming.cancelled_at;"),
  swap("M38-handlers-pii-comes-back", "a late event restores email/customer on a redacted order", "src/handlers.ts", "keepPiiOut ? null : incoming.customer_id, keepPiiOut ? null : incoming.email", "incoming.customer_id, incoming.email"),
  // ---- Admin client, orders
  swap("M39-client-throttle-not-retried", "THROTTLED is no longer retried", "src/admin-client.ts", 'if (codes.has("THROTTLED")) {', "if (false) {"),
  swap("M40-client-no-minimum-backoff", "the throttle wait may be shorter than the recommended 1 second", "src/admin-client.ts", "return Math.min(this.maxBackoffMs, Math.max(this.minBackoffMs, ms));", "return Math.min(this.maxBackoffMs, ms);"),
  swap("M41-client-no-pacing", "the client never waits for the bucket before sending", "src/admin-client.ts", "if (this.bucket === null || available === null || needed <= available || this.bucket.restoreRate <= 0) return 0;", "return 0;"),
  swap("M42-client-retry-after-ignored", "Retry-After is ignored", "src/admin-client.ts", "const floor = retryAfterSeconds !== undefined ? Math.ceil(retryAfterSeconds * 1000) : 0;", "const floor = 0;"),
  swap("M43-client-partial-silently-accepted", "a response with data and errors is returned as if complete", "src/admin-client.ts", "if (!options.allowPartial) {", "if (false) {"),
  swap("M44-client-version-mismatch-ignored", "strictVersion no longer notices a fall-forward", "src/admin-client.ts", "if (this.strictVersion && answeredVersion !== null && answeredVersion !== this.apiVersion) {", "if (false) {"),
  swap("M45-client-5xx-not-retried", "HTTP 5xx is no longer retried", "src/admin-client.ts", "if (status === 429 || status >= 500) {", "if (status === 429) {"),
  swap("M46-client-jitter-uncapped", "jittered backoff may exceed maxBackoffMs", "src/admin-client.ts", "const jittered = Math.min(this.maxBackoffMs, Math.round(exponential * (0.8 + 0.4 * this.random())));", "const jittered = Math.round(exponential * (0.8 + 0.4 * this.random()));"),
  swap("M47-client-default-version", "the default API version changes", "src/admin-client.ts", 'export const DEFAULT_API_VERSION = "2026-10";', 'export const DEFAULT_API_VERSION = "2026-07";'),
  swap("M48-orders-truncation-ignored", "a nested connection with hasNextPage is accepted", "src/orders.ts", "if (conn.pageInfo?.hasNextPage) {", "if (false) {"),
  swap("M49-orders-refund-limit-off-by-one", "refunds reaching the limit are no longer treated as possibly truncated", "src/orders.ts", "if (order.refunds.length >= limits.refunds) {", "if (order.refunds.length > limits.refunds) {"),
  swap("M50-orders-no-halving", "MAX_COST_EXCEEDED no longer halves the page size", "src/orders.ts", "if (error instanceof QueryCostError && pageSize > 1) {", "if (false) {"),
  swap("M51-orders-cursor-loop-unguarded", "a repeated cursor is no longer detected", "src/orders.ts", "if (seenCursors.has(endCursor)) throw new PaginationError(", "if (false) throw new PaginationError("),
  swap("M52-orders-cap-unguarded", "the 25,000-object pagination cap is no longer detected", "src/orders.ts", "if (fetched >= PAGINATION_CAP) {", "if (false) {"),
  swap("M53-orders-test-orders-requested", "the default search no longer excludes test orders", "src/orders.ts", 'if (options.excludeTest ?? true) terms.push("test:false");', 'if (options.excludeTest ?? false) terms.push("test:false");'),
  swap("M54-orders-always-shop-money", "presentment mode still asks for shopMoney", "src/orders.ts", 'return mode === "shop" ? "{ shopMoney { amount currencyCode } }" : "{ presentmentMoney { amount currencyCode } }";', 'return "{ shopMoney { amount currencyCode } }";'),
  // ---- aggregator
  swap("M55-agg-utc-days", "sales are bucketed by UTC day", "src/aggregate.ts", "day: localDay(order[dateField], timeZone), gross", "day: localDay(order[dateField], \"UTC\"), gross"),
  swap("M56-agg-refund-on-order-day", "refunds are attributed to the order's day instead of the refund's day", "src/aggregate.ts", "day: localDay(refund.processedAt, timeZone), items", "day: localDay(order[dateField], timeZone), items"),
  swap("M57-agg-counts-test-orders", "test orders are counted", "src/aggregate.ts", "if (order.test && excludeTest) {", "if (false) {"),
  swap("M58-agg-counts-cancelled-orders", "cancelled orders are counted", "src/aggregate.ts", "if (order.cancelledAt && excludeCancelled) {", "if (false) {"),
  swap("M59-agg-net-ignores-discounts", "net_sales forgets discounts", "src/aggregate.ts", "m.net_sales = m.gross_sales - m.discounts - m.net_sales_reversals;", "m.net_sales = m.gross_sales - m.net_sales_reversals;"),
  swap("M60-agg-total-ignores-tax-reversals", "total_sales forgets tax reversals", "src/aggregate.ts", "+ (m.taxes - m.tax_reversals) - m.other_refunds;", "+ m.taxes - m.other_refunds;"),
  swap("M61-agg-counts-failed-refunds", "refunds whose transactions all failed are counted", "src/aggregate.ts", 'if (verdict === "failed") {', "if (false) {"),
  swap("M62-agg-tax-included-accepted", "orders with taxes included are accepted instead of refused", "src/aggregate.ts", "if (order.taxesIncluded) {", "if (false) {"),
  swap("M63-agg-subtotal-unchecked", "the subtotal cross-check is gone", "src/aggregate.ts", "if (subtotal !== gross - discounts) {", "if (false) {"),
  swap("M64-agg-total-unchecked", "the order total cross-check is gone", "src/aggregate.ts", "if (totalPrice !== rebuilt) {", "if (false) {"),
  swap("M65-agg-removed-shipping-counted", "shipping lines marked isRemoved are counted", "src/aggregate.ts", ".filter((s) => !s.isRemoved)", ""),
  swap("M66-agg-window-end-exclusive", "the last day of the window is dropped", "src/aggregate.ts", "(options.until === undefined || day <= options.until)", "(options.until === undefined || day < options.until)"),
  swap("M67-agg-gift-cards-accepted", "gift card lines are accepted instead of refused", "src/aggregate.ts", "if (order.lineItems.nodes.some((l) => l.isGiftCard)) {", "if (false) {"),
  swap("M68-agg-currency-mismatch-unchecked", "an amount in the wrong currency is accepted", "src/aggregate.ts", "if (money.currencyCode !== currency) {", "if (false) {"),
  swap("M69-agg-unexplained-refund-accepted", "a refund total that its parts do not explain is accepted", "src/aggregate.ts", "if (refund.orderAdjustments.nodes.length > 0) {", "if (true) {"),
  // ---- reconcile, server
  swap("M70-reconcile-one-cent-tolerance", "a row may differ by one minor unit", "src/reconcile.ts", "if (row[metric] !== expected) {", "if (Math.abs(row[metric] - expected) > 1) {"),
  swap("M71-reconcile-totals-unchecked", "totals are not compared", "src/reconcile.ts", "if (actualTotals[metric] !== expected) {", "if (false) {"),
  swap("M72-server-no-body-limit", "the request body size limit is not enforced", "src/server.ts", "if (size > limit) {", "if (false) {"),
  swap("M73-server-state-cookie-missing", "the install redirect no longer sets the state cookie", "src/server.ts", 'res.writeHead(302, { location: start.redirectUrl, "set-cookie": start.setCookie });', "res.writeHead(302, { location: start.redirectUrl });"),
];

/** pid -> ppid for every process, from `ps`. */
function processTable() {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).split("\n");
  const table = new Map();
  for (const row of rows) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}
function descendantsOf(root, table = processTable()) {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, ppid] of table) if (ppid === parent && !out.includes(pid)) { out.push(pid); queue.push(pid); }
  }
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const active = new Set();
/** Kills the process, its whole descendant tree and its process group. Returns how many of them were still alive afterwards. */
async function killTree(pid) {
  const victims = [pid, ...descendantsOf(pid)];
  try { process.kill(-pid, "SIGKILL"); } catch { /* group already gone */ }
  for (const v of victims.reverse()) { try { process.kill(v, "SIGKILL"); } catch { /* already gone */ } }
  await new Promise((r) => setTimeout(r, 500));
  return victims.filter(alive).length;
}
function killAllActive() {
  for (const pid of active) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
    for (const d of descendantsOf(pid)) { try { process.kill(d, "SIGKILL"); } catch { /* ignore */ } }
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { killAllActive(); process.exit(130); });
process.on("exit", killAllActive);

function run(cwd, extra = [], timeoutMs = RUN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(cwd, "node_modules", "vitest", "vitest.mjs"), "run", "--reporter=default", ...extra], {
      cwd,
      detached: true, // own process group, so the whole tree can be killed at once
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    active.add(child.pid);
    let out = "";
    let timedOut = false;
    let leftover = 0;
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    // Resolve on "exit", not "close": a grandchild that keeps the output pipe open must not be able to block us.
    const done = async (code) => {
      clearTimeout(timer);
      if (!timedOut) leftover = await killTree(child.pid); // sweep workers that outlived a --bail shutdown
      active.delete(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: timedOut ? null : code, out, timedOut, leftover });
    };
    const timer = setTimeout(async () => {
      timedOut = true;
      leftover = await killTree(child.pid);
    }, timeoutMs);
    child.on("exit", (code) => { void done(code); });
  });
}

function prepare(id) {
  const dir = path.join(WORK, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of COPY.filter((n) => existsSync(path.join(ROOT, n)))) cpSync(path.join(ROOT, name), path.join(dir, name), { recursive: true });
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

function firstFailure(out) {
  const m = /FAIL\s+(.+)/.exec(out) ?? /×\s+(.+)/.exec(out);
  return m ? m[1].trim().replace(/\s+\d+ms$/, "") : "";
}

const failedTestFile = (out) => /FAIL\s+(test\/[^\s>]+)/.exec(out)?.[1];
/** "Test Files  3 failed | 14 passed (17)" and "Tests  5 failed | 460 passed (465)" -> failed counts. */
function failureCounts(out) {
  const n = (label) => Number(new RegExp(`${label}\\s+(?:(\\d+) failed)`).exec(out)?.[1] ?? 0);
  return { files: n("Test Files"), tests: n("Tests") };
}

/** Runs the suite on a mutated copy and decides: killed, SURVIVED, TIMEOUT, NOT-CONFIRMED or INCONCLUSIVE. */
async function evaluate(dir) {
  let leftover = 0;
  let last = { status: "INCONCLUSIVE", by: "" };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await run(dir);
    leftover += r.leftover;
    if (r.code === 0 && !r.timedOut) return { status: "SURVIVED", by: "", leftover, tests: 0, files: 0 };
    const counts = failureCounts(r.out);
    const file = failedTestFile(r.out);
    if (!file) {
      last = r.timedOut
        ? { status: "TIMEOUT", by: `no test had failed when the run was killed after ${Math.round(RUN_TIMEOUT_MS / 60000)} min (not a kill)` }
        : { status: "INCONCLUSIVE", by: "the run failed without a failing test (crash?)" };
      continue;
    }
    // A kill only counts if the failing file fails again on its own, by assertion, within its own time limit.
    const again = await run(dir, [file], CONFIRM_TIMEOUT_MS);
    leftover += again.leftover;
    const reproduced = !again.timedOut && again.code !== 0 && /FAIL /.test(again.out) && !/timed out/i.test(again.out);
    if (reproduced && counts.tests === 0) {
      last = { status: "NOT-CONFIRMED", by: `${file} failed as a whole (import or setup error), not by an assertion` };
      continue;
    }
    if (reproduced) return { status: "killed", by: firstFailure(r.out), leftover, ...counts };
    last = r.timedOut || again.timedOut
      ? { status: "TIMEOUT", by: `run was cut off by the timeout and ${file} did not fail again on its own (not a kill)` }
      : { status: "NOT-CONFIRMED", by: `failed in ${file} but the failure did not reproduce by assertion` };
  }
  return { tests: 0, files: 0, ...last, leftover };
}

async function selftest() {
  // A test file that spins forever in a synchronous loop: vitest cannot time it out, so only this script's own timeout can end it.
  const dir = prepare("selftest-hang");
  const target = path.join(dir, "test/hmac.test.ts");
  writeFileSync(target, "while (true) {}\n" + readFileSync(target, "utf8"));
  const started = Date.now();
  const r = await run(dir, [], 15_000);
  const seconds = Math.round((Date.now() - started) / 1000);
  rmSync(WORK, { recursive: true, force: true });
  const ok = r.timedOut && r.leftover === 0 && seconds < 40;
  if (!ok && args.includes("--verbose")) console.log(r.out.split("\n").slice(-40).join("\n"));
  console.log(`selftest: timedOut=${r.timedOut} leftoverProcesses=${r.leftover} elapsed=${seconds}s -> ${ok ? "OK, the hang was cut off and no process was left behind" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}

function validate() {
  let bad = 0;
  for (const m of MUTANTS) {
    try {
      const text = readFileSync(path.join(ROOT, m.file), "utf8");
      const mutated = m.apply(text);
      if (mutated === text) throw new Error("mutation changed nothing");
    } catch (error) {
      bad++;
      console.error(`INVALID ${m.id}: ${error.message}`);
    }
  }
  const ids = new Set(MUTANTS.map((m) => m.id));
  if (ids.size !== MUTANTS.length) { bad++; console.error("duplicate mutant ids"); }
  console.log(`${MUTANTS.length - bad}/${MUTANTS.length} mutants apply cleanly to the current source`);
  process.exit(bad ? 1 : 0);
}

async function main() {
  if (VALIDATE) return validate();
  if (!existsSync(path.join(ROOT, "node_modules"))) { console.error("run npm ci first"); process.exit(2); }
  mkdirSync(WORK, { recursive: true });
  if (SELFTEST) return selftest();
  const selected = MUTANTS.filter((m) => ONLY.length === 0 || ONLY.includes(m.id));

  // Baseline: the unmodified copy must pass, otherwise "killed" would mean nothing.
  console.log("baseline: running the suite on an unmodified copy ...");
  const baseDir = prepare("baseline");
  let base = await run(baseDir);
  if (base.code !== 0) { console.log(`baseline ${base.timedOut ? "timed out" : "failed"} once; retrying once to rule out a slow machine ...`); base = await run(baseDir); }
  if (base.code !== 0) { console.error(base.out.split("\n").slice(-40).join("\n")); console.error("baseline failed; mutation results would be meaningless."); process.exit(2); }
  console.log("baseline passed.\n");
  rmSync(baseDir, { recursive: true, force: true });

  const results = [];
  for (const m of selected) {
    const dir = prepare(m.id);
    const target = path.join(dir, m.file);
    writeFileSync(target, m.apply(readFileSync(target, "utf8")));
    const started = Date.now();
    const verdict = await evaluate(dir);
    results.push({ ...m, ...verdict, seconds: Math.round((Date.now() - started) / 1000) });
    const noticed = verdict.status === "killed" ? `, ${verdict.tests} test(s) in ${verdict.files} file(s)` : "";
    console.log(`${verdict.status.padEnd(13)} ${m.id}  (${results.at(-1).seconds}s${noticed}${verdict.leftover ? `, ${verdict.leftover} stray process(es) after cleanup` : ""})`);
    if (!KEEP) rmSync(dir, { recursive: true, force: true });
  }
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });

  results.sort((a, b) => a.id.localeCompare(b.id));
  const killed = results.filter((r) => r.status === "killed").length;
  const lines = ["| Mutant | What was broken | Result | Tests / files that failed | First failing test |", "|---|---|---|---|---|"];
  for (const r of results) lines.push(`| ${r.id} | ${r.desc}${r.note ? ` (${r.note})` : ""} | ${r.status} | ${r.status === "killed" ? `${r.tests} / ${r.files}` : "-"} | ${r.by || "-"} |`);
  const rate = results.length ? Math.round((killed / results.length) * 100) : 0;
  lines.push("", `Kill rate: ${killed}/${results.length} (${rate}%)`);
  const bad = results.filter((r) => r.status !== "killed");
  const thin = results.filter((r) => r.status === "killed" && r.tests === 1);
  if (thin.length) lines.push(`Killed by exactly one test (thin coverage): ${thin.map((r) => r.id).join(", ")}`);
  if (bad.length) lines.push(`Not killed: ${bad.map((r) => `${r.id} (${r.status})`).join(", ")}`);
  const strays = results.reduce((n, r) => n + (r.leftover ?? 0), 0);
  lines.push(`Stray processes left after cleanup: ${strays}`);
  console.log("\n" + lines.join("\n"));
  if (WRITE) {
    const header = [`# Mutation check results`, "", `Run with \`node scripts/mutation-check.mjs\` on ${new Date().toISOString().slice(0, 10)}, Node ${process.version}, ${os.platform()} ${os.arch()}, one mutant at a time.`, `A mutant counts as killed only when a failing test file fails again on its own by assertion. Source is mutated in a throwaway copy; the real tree is never touched.`, ""];
    writeFileSync(path.resolve(ROOT, WRITE), header.concat(lines).join("\n") + "\n");
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { killAllActive(); console.error(e); process.exit(2); });
