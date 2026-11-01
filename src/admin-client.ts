// Minimal Admin GraphQL client: pinned API version, cost-aware pacing, and explicit handling of the ways a
// request can go wrong. What the docs say (see docs/SOURCES.md) and what is done here:
//
//  * The endpoint is POST https://{shop}/admin/api/{version}/graphql.json with X-Shopify-Access-Token.
//  * GraphQL errors come back as HTTP 200 with an `errors` array; read errors[n].extensions.code, not the
//    status. THROTTLED = rate limit hit; MAX_COST_EXCEEDED = single query over the cost limit (1000);
//    ACCESS_DENIED = missing scope or bad credentials; INTERNAL_SERVER_ERROR = Shopify-side failure;
//    SHOP_INACTIVE.
//  * Every response may carry extensions.cost = { requestedQueryCost, actualQueryCost, throttleStatus:
//    { maximumAvailable, currentlyAvailable, restoreRate } }. The bucket needs room for the REQUESTED cost
//    before a query runs and is refunded (requested - actual) afterwards.
//  * "The recommended backoff time is one second."
//  * A version that is no longer served is answered with the oldest supported one ("falls forward"); the
//    X-Shopify-API-Version response header says which version actually answered.
import { isValidShopDomain } from "./shop.ts";

export const DEFAULT_API_VERSION = "2026-10";
// Stable versions are named YYYY-MM and released quarterly (01, 04, 07, 10); `unstable` is the in-progress one.
const VERSION_PATTERN = /^\d{4}-(01|04|07|10)$/;

export function isValidApiVersion(version: unknown): version is string {
  return typeof version === "string" && (VERSION_PATTERN.test(version) || version === "unstable");
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}
export interface CostInfo {
  requestedQueryCost?: number;
  actualQueryCost?: number | null;
  throttleStatus?: ThrottleStatus;
}
export interface GraphQLErrorItem {
  message?: string;
  path?: unknown[];
  extensions?: { code?: string; [key: string]: unknown };
}

export class ShopifyApiError extends Error {
  override name = "ShopifyApiError";
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly errors: GraphQLErrorItem[] | undefined;
  constructor(message: string, details: { status?: number; code?: string; errors?: GraphQLErrorItem[] } = {}) {
    super(message);
    this.status = details.status;
    this.code = details.code;
    this.errors = details.errors;
  }
}
export class ThrottledError extends ShopifyApiError {
  override name = "ThrottledError";
}
export class QueryCostError extends ShopifyApiError {
  override name = "QueryCostError";
}
export class AuthError extends ShopifyApiError {
  override name = "AuthError";
}
export class PartialResponseError extends ShopifyApiError {
  override name = "PartialResponseError";
  readonly data: unknown;
  constructor(message: string, data: unknown, errors: GraphQLErrorItem[]) {
    super(message, { errors });
    this.data = data;
  }
}
export class VersionMismatchError extends ShopifyApiError {
  override name = "VersionMismatchError";
}

export interface AdminClientOptions {
  /** myshopify.com domain, validated against the documented pattern. */
  shop: string;
  accessToken: string;
  /** Pinned API version. Default 2026-10 (latest stable when this kit was written). Always sent, never "latest". */
  apiVersion?: string;
  /** Origin to talk to instead of https://{shop}; used by the tests to reach the local mock. */
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 0..1, used for backoff jitter. Inject a constant in tests. */
  random?: () => number;
  /** Retries after the first attempt for throttling, 5xx, 429 and network errors. Default 5. */
  maxRetries?: number;
  /** Docs: "The recommended backoff time is one second." */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Throw VersionMismatchError when the answering version differs from the pinned one (default: false, the version is just reported). */
  strictVersion?: boolean;
  /** Cost to assume for a query shape never seen before (default 0: no proactive wait on the first call). */
  assumedCost?: number;
}

export interface GraphQLResult<T> {
  data: T;
  extensions: { cost?: CostInfo } & Record<string, unknown>;
  /** Value of X-Shopify-API-Version on the answering response (null if absent). */
  apiVersion: string | null;
  /** Requests sent for this call, including the successful one. */
  attempts: number;
  /** Milliseconds slept for pacing and backoff during this call. */
  waitedMs: number;
}

export interface RequestOptions {
  /** Return `data` even when the response also has `errors` (a partial result). Default false. */
  allowPartial?: boolean;
  operationName?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AdminClient {
  readonly shop: string;
  readonly apiVersion: string;
  private readonly origin: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly maxRetries: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly strictVersion: boolean;
  private readonly assumedCost: number;
  private bucket: (ThrottleStatus & { asOf: number }) | null = null;
  private readonly costByQuery = new Map<string, number>();

  constructor(options: AdminClientOptions) {
    if (!isValidShopDomain(options.shop)) throw new Error(`invalid shop domain: ${JSON.stringify(options.shop)}`);
    if (typeof options.accessToken !== "string" || options.accessToken.length === 0) throw new Error("accessToken is required");
    const version = options.apiVersion ?? DEFAULT_API_VERSION;
    if (!isValidApiVersion(version)) throw new Error(`invalid API version ${JSON.stringify(version)} (expected YYYY-01|04|07|10 or "unstable")`);
    this.shop = options.shop.toLowerCase();
    this.apiVersion = version;
    this.token = options.accessToken;
    this.origin = (options.baseUrl ?? `https://${this.shop}`).replace(/\/+$/, "");
    this.doFetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.maxRetries = options.maxRetries ?? 5;
    this.minBackoffMs = options.minBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.strictVersion = options.strictVersion ?? false;
    this.assumedCost = options.assumedCost ?? 0;
  }

  get endpoint(): string {
    return `${this.origin}/admin/api/${this.apiVersion}/graphql.json`;
  }

  /** Last known bucket state, projected to now (null before the first response that carried throttleStatus). */
  estimatedAvailable(): number | null {
    if (!this.bucket) return null;
    const elapsedSeconds = Math.max(0, this.now() - this.bucket.asOf) / 1000;
    return Math.min(this.bucket.maximumAvailable, this.bucket.currentlyAvailable + elapsedSeconds * this.bucket.restoreRate);
  }

  private async pace(query: string): Promise<number> {
    const needed = this.costByQuery.get(query) ?? this.assumedCost;
    const available = this.estimatedAvailable();
    if (this.bucket === null || available === null || needed <= available || this.bucket.restoreRate <= 0) return 0;
    const waitMs = Math.min(this.maxBackoffMs, Math.ceil(((needed - available) / this.bucket.restoreRate) * 1000)); // no single sleep above maxBackoffMs; if the bucket is still short the request is throttled and retried
    await this.sleep(waitMs);
    return waitMs;
  }

  private remember(query: string, cost: CostInfo | undefined): void {
    if (!cost) return;
    if (typeof cost.requestedQueryCost === "number") this.costByQuery.set(query, cost.requestedQueryCost);
    const t = cost.throttleStatus;
    if (t && Number.isFinite(t.maximumAvailable) && Number.isFinite(t.currentlyAvailable) && Number.isFinite(t.restoreRate)) {
      this.bucket = { ...t, asOf: this.now() };
    }
  }

  private backoffMs(attempt: number, retryAfterSeconds?: number): number {
    const exponential = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** attempt);
    const jittered = Math.min(this.maxBackoffMs, Math.round(exponential * (0.8 + 0.4 * this.random())));
    const floor = retryAfterSeconds !== undefined ? Math.ceil(retryAfterSeconds * 1000) : 0;
    return Math.max(this.minBackoffMs, floor, jittered); // a Retry-After from Shopify is honoured even above maxBackoffMs
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<GraphQLResult<T>> {
    let waitedMs = 0;
    let lastFailure: ShopifyApiError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      waitedMs += await this.pace(query);
      let response: Response;
      try {
        response = await this.doFetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-shopify-access-token": this.token,
          },
          body: JSON.stringify({ query, variables, ...(options.operationName ? { operationName: options.operationName } : {}) }),
        });
      } catch (cause) {
        lastFailure = new ShopifyApiError(`network error talking to ${this.origin}: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (attempt === this.maxRetries) break;
        const ms = this.backoffMs(attempt);
        await this.sleep(ms);
        waitedMs += ms;
        continue;
      }

      const status = response.status;
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader !== null && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) : undefined;

      if (status === 401) throw new AuthError("401 Unauthorized: the access token is missing, expired or revoked (re-authorise or refresh it)", { status });
      if (status === 402 || status === 403 || status === 404 || status === 423) {
        throw new ShopifyApiError(`HTTP ${status} from the Admin API (not retryable)`, { status });
      }
      if (status === 429 || status >= 500) {
        lastFailure = new ShopifyApiError(`HTTP ${status} from the Admin API`, { status });
        if (attempt === this.maxRetries) break;
        const ms = this.backoffMs(attempt, retryAfter);
        await this.sleep(ms);
        waitedMs += ms;
        continue;
      }
      if (status < 200 || status >= 300) throw new ShopifyApiError(`unexpected HTTP ${status} from the Admin API`, { status });

      let body: { data?: unknown; errors?: GraphQLErrorItem[]; extensions?: Record<string, unknown> };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        lastFailure = new ShopifyApiError("response body was not valid JSON", { status });
        if (attempt === this.maxRetries) break;
        const ms = this.backoffMs(attempt);
        await this.sleep(ms);
        waitedMs += ms;
        continue;
      }
      const extensions = (body.extensions ?? {}) as GraphQLResult<T>["extensions"];
      this.remember(query, extensions.cost);

      const answeredVersion = response.headers.get("x-shopify-api-version");
      if (this.strictVersion && answeredVersion !== null && answeredVersion !== this.apiVersion) {
        throw new VersionMismatchError(`pinned ${this.apiVersion} but Shopify answered with ${answeredVersion} (the pinned version is no longer served)`, { status });
      }

      const errors = Array.isArray(body.errors) ? body.errors : [];
      if (errors.length > 0) {
        const codes = new Set(errors.map((e) => e.extensions?.code).filter((c): c is string => typeof c === "string"));
        if (codes.has("THROTTLED")) {
          lastFailure = new ThrottledError("THROTTLED: the app's query-cost bucket is exhausted", { status, code: "THROTTLED", errors });
          if (attempt === this.maxRetries) break;
          const wait = this.throttleWaitMs(extensions.cost, query, attempt);
          await this.sleep(wait);
          waitedMs += wait;
          continue;
        }
        if (codes.has("MAX_COST_EXCEEDED")) throw new QueryCostError(errors[0]?.message ?? "query cost exceeds the single-query limit", { status, code: "MAX_COST_EXCEEDED", errors });
        if (codes.has("ACCESS_DENIED")) throw new AuthError("ACCESS_DENIED: missing access scope or invalid credentials", { status, code: "ACCESS_DENIED", errors });
        if (codes.has("SHOP_INACTIVE")) throw new ShopifyApiError("SHOP_INACTIVE: the shop is not active", { status, code: "SHOP_INACTIVE", errors });
        if (codes.has("INTERNAL_SERVER_ERROR")) {
          lastFailure = new ShopifyApiError("INTERNAL_SERVER_ERROR reported by Shopify", { status, code: "INTERNAL_SERVER_ERROR", errors });
          if (attempt === this.maxRetries) break;
          const ms = this.backoffMs(attempt);
          await this.sleep(ms);
          waitedMs += ms;
          continue;
        }
        if (body.data === undefined || body.data === null) {
          throw new ShopifyApiError(`GraphQL errors: ${errors.map((e) => e.message ?? "(no message)").join("; ")}`, { status, errors });
        }
        if (!options.allowPartial) {
          throw new PartialResponseError(`partial response: data was returned together with ${errors.length} error(s): ${errors.map((e) => e.message ?? "(no message)").join("; ")}`, body.data, errors);
        }
      }
      if (body.data === undefined || body.data === null) throw new ShopifyApiError("response had neither data nor errors", { status });
      return { data: body.data as T, extensions, apiVersion: answeredVersion, attempts: attempt + 1, waitedMs };
    }
    throw lastFailure ?? new ShopifyApiError("request failed");
  }

  /** Wait after THROTTLED: until the bucket can hold the requested cost, but never less than the recommended one second. */
  private throttleWaitMs(cost: CostInfo | undefined, query: string, attempt: number): number {
    const t = cost?.throttleStatus;
    const requested = cost?.requestedQueryCost ?? this.costByQuery.get(query);
    if (t && typeof requested === "number" && t.restoreRate > 0) {
      const ms = Math.ceil(((requested - t.currentlyAvailable) / t.restoreRate) * 1000);
      return Math.min(this.maxBackoffMs, Math.max(this.minBackoffMs, ms));
    }
    return this.backoffMs(attempt);
  }
}
