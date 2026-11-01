// OAuth authorization code grant for an app that runs its own backend (docs: "Authenticate a standalone or
// API-only app"). Steps and what is validated:
//
//   install   validate `shop` against the documented pattern, issue a random `state` (nonce), redirect to
//             https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state
//   callback  1. shop pattern   2. query-string HMAC (hex, sorted key=value, client secret, constant-time)
//             3. state equals the nonce stored in the browser cookie AND was issued by us, once, for this shop
//             4. code present   5. POST https://{shop}/admin/oauth/access_token (form-encoded)
//             6. granted scopes cover the requested ones (a write_x grant covers read_x)
//
// Shopify CLI template apps use "managed installation" and never run this flow; this module is for
// standalone/API-only apps (custom-distribution integrations with their own backend).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { verifyOauthHmac, type QueryParams } from "./hmac.ts";
import { isValidShopDomain } from "./shop.ts";

export const STATE_COOKIE_NAME = "shopify_oauth_state";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must exactly match a redirect URI configured for the app; never taken from the request. */
  redirectUri: string;
  scopes: readonly string[];
  /** Ask for an online (per-user) token instead of an offline one. Default false. */
  online?: boolean;
  /** Docs: "New public apps must use expiring offline access tokens". Sends expiring=1. Default true. */
  expiring?: boolean;
  /** Origin of a shop's admin, default `https://{shop}`. Only the tests change this (to reach the local mock). */
  shopOrigin?: (shop: string) => string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Reject callbacks whose `timestamp` is older than this many seconds. The docs do not require it; default off. */
  maxTimestampAgeSeconds?: number;
  requestTimeoutMs?: number;
}

const SCOPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export function validateOAuthConfig(config: OAuthConfig): void {
  if (!config.clientId) throw new Error("clientId is required");
  if (!config.clientSecret) throw new Error("clientSecret is required");
  if (config.scopes.length === 0) throw new Error("at least one scope is required");
  for (const s of config.scopes) if (!SCOPE_PATTERN.test(s)) throw new Error(`invalid scope ${JSON.stringify(s)} (expected something like read_orders)`);
  let url: URL;
  try {
    url = new URL(config.redirectUri);
  } catch {
    throw new Error("redirectUri must be an absolute URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("redirectUri must be https (http is allowed only for localhost)");
}

const originOf = (config: OAuthConfig, shop: string): string => (config.shopOrigin ? config.shopOrigin(shop) : `https://${shop}`).replace(/\/+$/, "");

// ---------------------------------------------------------------------------------------------- state / nonce

export interface NonceStore {
  /** Creates a random nonce bound to `shop`. */
  issue(shop: string): string;
  /** True once, and only for an unexpired nonce that was issued for this very shop. */
  consume(nonce: string, shop: string): boolean;
  size(): number;
}

export function createNonceStore(options: { ttlMs?: number; now?: () => number } = {}): NonceStore {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { shop: string; expiresAt: number }>();
  const sweep = (): void => {
    const t = now();
    for (const [k, v] of entries) if (v.expiresAt <= t) entries.delete(k);
  };
  return {
    issue(shop) {
      sweep();
      const nonce = randomBytes(16).toString("hex");
      entries.set(nonce, { shop: shop.toLowerCase(), expiresAt: now() + ttlMs });
      return nonce;
    },
    consume(nonce, shop) {
      const entry = entries.get(nonce);
      if (!entry) return false;
      entries.delete(nonce); // single use, even when the shop does not match
      return entry.expiresAt > now() && entry.shop === shop.toLowerCase();
    },
    size() {
      sweep();
      return entries.size;
    },
  };
}

function safeEqualStrings(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------------------------- install

export type InstallStart =
  | { ok: true; shop: string; state: string; redirectUrl: string; setCookie: string }
  | { ok: false; status: 400; reason: "invalid_shop" };

export function beginInstall(config: OAuthConfig, query: { shop?: unknown }, nonces: NonceStore): InstallStart {
  validateOAuthConfig(config);
  if (!isValidShopDomain(query.shop)) return { ok: false, status: 400, reason: "invalid_shop" };
  const shop = query.shop.toLowerCase();
  const state = nonces.issue(shop);
  const params = new URLSearchParams({ client_id: config.clientId, scope: config.scopes.join(","), redirect_uri: config.redirectUri, state });
  let redirectUrl = `${originOf(config, shop)}/admin/oauth/authorize?${params.toString()}`;
  if (config.online) redirectUrl += "&grant_options[]=per-user";
  const secure = new URL(config.redirectUri).protocol === "https:" ? "; Secure" : "";
  const setCookie = `${STATE_COOKIE_NAME}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}`;
  return { ok: true, shop, state, redirectUrl, setCookie };
}

// ---------------------------------------------------------------------------------------------- tokens

export interface TokenSet {
  accessToken: string;
  /** Granted scopes, as returned by Shopify. */
  scope: string[];
  /** Epoch ms when the access token expires (expiring tokens only). */
  expiresAt?: number;
  refreshToken?: string;
  refreshTokenExpiresAt?: number;
  /** Present for online tokens. */
  associatedUser?: unknown;
}

export class TokenExchangeError extends Error {
  override name = "TokenExchangeError";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

async function postForm(config: OAuthConfig, shop: string, form: Record<string, string>): Promise<Response> {
  const doFetch = config.fetch ?? fetch;
  return doFetch(`${originOf(config, shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    // never follow a redirect: a 307/308 would resend client_secret to wherever it points
    redirect: "manual",
    signal: AbortSignal.timeout(config.requestTimeoutMs ?? 10_000),
  });
}

function parseTokenBody(body: unknown, now: number): TokenSet {
  if (typeof body !== "object" || body === null) throw new TokenExchangeError("token response is not a JSON object");
  const b = body as Record<string, unknown>;
  if (typeof b["access_token"] !== "string" || b["access_token"].length === 0) throw new TokenExchangeError("token response has no access_token");
  const scope = typeof b["scope"] === "string" ? b["scope"].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const tokens: TokenSet = { accessToken: b["access_token"], scope };
  if (typeof b["expires_in"] === "number" && Number.isFinite(b["expires_in"])) tokens.expiresAt = now + b["expires_in"] * 1000;
  if (typeof b["refresh_token"] === "string") tokens.refreshToken = b["refresh_token"];
  if (typeof b["refresh_token_expires_in"] === "number" && Number.isFinite(b["refresh_token_expires_in"])) tokens.refreshTokenExpiresAt = now + b["refresh_token_expires_in"] * 1000;
  if (b["associated_user"] !== undefined) tokens.associatedUser = b["associated_user"];
  return tokens;
}

/** POST /admin/oauth/access_token with client_id, client_secret, code (+ expiring=1). */
export async function exchangeAuthorizationCode(config: OAuthConfig, shop: string, code: string): Promise<TokenSet> {
  validateOAuthConfig(config);
  if (!isValidShopDomain(shop)) throw new TokenExchangeError("invalid shop domain");
  const form: Record<string, string> = { client_id: config.clientId, client_secret: config.clientSecret, code };
  if (config.expiring ?? true) form["expiring"] = "1";
  let response: Response;
  try {
    response = await postForm(config, shop.toLowerCase(), form);
  } catch (cause) {
    throw new TokenExchangeError(`token request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) throw new TokenExchangeError(`token endpoint answered HTTP ${response.status}`, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TokenExchangeError("token response was not valid JSON", response.status);
  }
  return parseTokenBody(body, (config.now ?? Date.now)());
}

export type RefreshOutcome =
  | { status: "refreshed"; tokens: TokenSet }
  | { status: "reauthorize" } // 401: the refresh token is terminal; send the merchant through install again
  | { status: "retry" } // network error, timeout, 429 or 5xx: retry later with the SAME refresh token
  | { status: "failed"; httpStatus: number }; // any other non-OK status: retrying sends the same request and fails the same way

/** grant_type=refresh_token. Outcome names follow the docs' sample. Store BOTH new tokens; the old pair is retired. */
export async function refreshAccessToken(config: OAuthConfig, shop: string, refreshToken: string): Promise<RefreshOutcome> {
  validateOAuthConfig(config);
  if (!isValidShopDomain(shop)) throw new Error("invalid shop domain");
  let response: Response;
  try {
    response = await postForm(config, shop.toLowerCase(), { client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken });
  } catch {
    return { status: "retry" };
  }
  if (response.status === 401) return { status: "reauthorize" };
  if (response.status === 429 || response.status >= 500) return { status: "retry" };
  if (!response.ok) return { status: "failed", httpStatus: response.status };
  try {
    return { status: "refreshed", tokens: parseTokenBody(await response.json(), (config.now ?? Date.now)()) };
  } catch {
    return { status: "failed", httpStatus: response.status };
  }
}

/** A write_x grant includes read_x, so a requested read_x is satisfied by a granted write_x. */
export function missingScopes(requested: readonly string[], granted: readonly string[]): string[] {
  return requested.filter((s) => !granted.includes(s) && !(s.startsWith("read_") && granted.includes(`write_${s.slice(5)}`)));
}

// ---------------------------------------------------------------------------------------------- callback

export type CallbackFailure = "invalid_shop" | "invalid_hmac" | "stale_timestamp" | "invalid_state" | "missing_code" | "token_exchange_failed" | "missing_scopes";
export type CallbackResult =
  | { ok: true; shop: string; tokens: TokenSet }
  | { ok: false; status: 400 | 403 | 502; reason: CallbackFailure; detail?: string };

export interface CallbackInput {
  query: QueryParams;
  /** Value of the state cookie the browser sent, if any. */
  stateCookie: string | undefined;
  nonces: NonceStore;
}

function field(query: QueryParams, name: string): string | undefined {
  const v = query instanceof URLSearchParams ? query.get(name) : query[name];
  return typeof v === "string" ? v : undefined;
}

export async function handleCallback(config: OAuthConfig, input: CallbackInput): Promise<CallbackResult> {
  validateOAuthConfig(config);
  const { query } = input;
  const shop = field(query, "shop");
  if (!isValidShopDomain(shop)) return { ok: false, status: 400, reason: "invalid_shop" };
  if (!verifyOauthHmac(config.clientSecret, query)) return { ok: false, status: 403, reason: "invalid_hmac" };

  if (config.maxTimestampAgeSeconds !== undefined) {
    const ts = Number(field(query, "timestamp"));
    const ageSeconds = (config.now ?? Date.now)() / 1000 - ts;
    if (!Number.isFinite(ts) || ageSeconds > config.maxTimestampAgeSeconds || ageSeconds < -config.maxTimestampAgeSeconds) {
      return { ok: false, status: 403, reason: "stale_timestamp" };
    }
  }

  const state = field(query, "state");
  if (!state || !input.stateCookie || !safeEqualStrings(state, input.stateCookie)) return { ok: false, status: 403, reason: "invalid_state" };
  if (!input.nonces.consume(state, shop)) return { ok: false, status: 403, reason: "invalid_state", detail: "nonce unknown, expired, already used or issued for another shop" };

  const code = field(query, "code");
  if (!code) return { ok: false, status: 400, reason: "missing_code" };

  let tokens: TokenSet;
  try {
    tokens = await exchangeAuthorizationCode(config, shop, code);
  } catch (error) {
    const status = error instanceof TokenExchangeError ? error.status : undefined;
    return { ok: false, status: status === 400 || status === 403 ? 403 : 502, reason: "token_exchange_failed", detail: error instanceof Error ? error.message : String(error) };
  }
  const missing = missingScopes(config.scopes, tokens.scope);
  if (missing.length > 0) return { ok: false, status: 403, reason: "missing_scopes", detail: `not granted: ${missing.join(", ")}` };
  return { ok: true, shop: shop.toLowerCase(), tokens };
}
