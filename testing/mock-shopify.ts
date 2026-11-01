// A local imitation of the parts of Shopify this kit talks to. It is a TEST DOUBLE built from the public docs,
// not a model of Shopify: it is as accurate as the pages it was written from (docs/SOURCES.md).
//
//   POST /admin/api/{version}/graphql.json   Admin GraphQL: orders + shop, selection sets validated against
//                                            testing/schema.ts, a toy cost model with a leaky bucket, THROTTLED /
//                                            MAX_COST_EXCEEDED / INTERNAL_SERVER_ERROR, version fall-forward header
//   POST /admin/oauth/access_token           authorization-code exchange and refresh-token grant
//
// Faults can be queued to make the next requests throttle, 5xx, drop the connection, return partial data, etc.
// Time comes from an injectable clock so pacing tests are instant and deterministic.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { closeServer, listenInRange } from "./ports.ts";
import { ORDER_SORT_KEYS, ROOT, SCHEMA, type FieldDef } from "./schema.ts";

// ------------------------------------------------------------------------------------------ mini GraphQL parser

interface FieldNode {
  name: string;
  args: string;
  selection: FieldNode[] | null;
}

class ParseError extends Error {}

function parseDocument(source: string): FieldNode[] {
  const src = source.replace(/#[^\n]*/g, "");
  let i = 0;
  const ws = (): void => {
    while (i < src.length && /[\s,]/.test(src[i]!)) i++;
  };
  const name = (): string => {
    ws();
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i));
    if (!m) throw new ParseError(`expected a name at offset ${i}`);
    i += m[0].length;
    return m[0];
  };
  const balanced = (open: string, close: string): string => {
    let depth = 0;
    const start = i;
    do {
      if (src[i] === open) depth++;
      else if (src[i] === close) depth--;
      i++;
      if (i > src.length) throw new ParseError("unbalanced brackets");
    } while (depth > 0);
    return src.slice(start + 1, i - 1);
  };
  const selection = (): FieldNode[] => {
    ws();
    if (src[i] !== "{") throw new ParseError("expected {");
    i++;
    const fields: FieldNode[] = [];
    for (;;) {
      ws();
      if (i >= src.length) throw new ParseError("missing }");
      if (src[i] === "}") {
        i++;
        return fields;
      }
      if (src.startsWith("...", i)) throw new ParseError("the mock does not support fragments");
      const fieldName = name();
      ws();
      if (src[i] === ":") throw new ParseError("the mock does not support aliases");
      let args = "";
      if (src[i] === "(") args = balanced("(", ")");
      ws();
      fields.push({ name: fieldName, args, selection: src[i] === "{" ? selection() : null });
    }
  };
  ws();
  if (src.startsWith("query", i) || src.startsWith("mutation", i)) {
    if (src.startsWith("mutation", i)) throw new ParseError("the mock supports queries only");
    i += 5;
    ws();
    if (/[_A-Za-z]/.test(src[i] ?? "")) name();
    ws();
    if (src[i] === "(") balanced("(", ")");
  }
  return selection();
}

function parseArgs(raw: string, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote = "";
  for (const ch of raw) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      current += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current);
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (val.startsWith("$")) out[key] = variables[val.slice(1)];
    else if (/^-?\d+$/.test(val)) out[key] = Number(val);
    else if (/^(true|false)$/.test(val)) out[key] = val === "true";
    else if (/^['"].*['"]$/.test(val)) out[key] = val.slice(1, -1);
    else out[key] = val;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ execution

interface ExecCtx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string; extensions: Record<string, unknown> }>;
  actual: number;
}

const undefinedField = (ctx: ExecCtx, typeName: string, fieldName: string): void => {
  ctx.errors.push({ message: `Field '${fieldName}' doesn't exist on type '${typeName}'`, extensions: { code: "undefinedField", typeName, fieldName } });
};

function firstArg(args: Record<string, unknown>): number | undefined {
  const f = args["first"];
  return typeof f === "number" && Number.isInteger(f) && f >= 0 ? f : undefined;
}

/** Requested cost: from the selection and `first` arguments only (never from data). Scalars 0, objects 1, connections sized by first. */
function requestedCost(selection: FieldNode[], variables: Record<string, unknown>, defs: Record<string, FieldDef>): number {
  let total = 0;
  for (const field of selection) {
    const def = defs[field.name];
    if (!def || def.kind === "scalar" || !field.selection) continue;
    const args = parseArgs(field.args, variables);
    const child = SCHEMA[def.type!] ?? {};
    if (def.kind === "object") {
      total += 1 + requestedCost(field.selection, variables, child);
    } else if (def.kind === "list") {
      const n = firstArg(args) ?? 10;
      total += 1 + n * (1 + requestedCost(field.selection, variables, child));
    } else {
      const n = firstArg(args) ?? 0;
      total += 1;
      for (const sub of field.selection) {
        if (sub.name === "nodes" && sub.selection) total += n * (1 + requestedCost(sub.selection, variables, child));
        else if (sub.name === "pageInfo") total += 1;
      }
    }
  }
  return total;
}

function project(typeName: string, value: Record<string, unknown>, selection: FieldNode[], ctx: ExecCtx, defs: Record<string, FieldDef>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const def = defs[field.name];
    if (!def) {
      undefinedField(ctx, typeName, field.name);
      continue;
    }
    const raw = value[field.name];
    if (def.kind === "scalar") {
      if (field.selection) ctx.errors.push({ message: `Selections can't be made on scalars (field '${field.name}' returns a scalar)`, extensions: { code: "selectionMismatch", fieldName: field.name } });
      out[field.name] = raw ?? null;
      continue;
    }
    if (!field.selection) {
      ctx.errors.push({ message: `Field must have selections (field '${field.name}' returns ${def.type})`, extensions: { code: "selectionMismatch", fieldName: field.name } });
      continue;
    }
    const args = parseArgs(field.args, ctx.variables);
    const childDefs = SCHEMA[def.type!] ?? {};
    ctx.actual += 1;
    if (def.kind === "object") {
      out[field.name] = raw == null ? null : project(def.type!, raw as Record<string, unknown>, field.selection, ctx, childDefs);
    } else if (def.kind === "list") {
      const items = Array.isArray(raw) ? raw : [];
      const n = firstArg(args);
      out[field.name] = (n === undefined ? items : items.slice(0, n)).map((item) => {
        ctx.actual += 1;
        return project(def.type!, item as Record<string, unknown>, field.selection!, ctx, childDefs);
      });
    } else {
      const n = firstArg(args);
      if (n === undefined) ctx.errors.push({ message: `you must provide a 'first' or 'last' value on '${field.name}'`, extensions: { code: "missingPaginationBoundaries", fieldName: field.name } });
      const nodes = ((raw as { nodes?: unknown[] } | undefined)?.nodes ?? []) as Array<Record<string, unknown>>;
      const page = nodes.slice(0, n ?? 0);
      const conn: Record<string, unknown> = {};
      for (const sub of field.selection) {
        if (sub.name === "nodes" && sub.selection) {
          conn["nodes"] = page.map((node) => {
            ctx.actual += 1;
            return project(def.type!, node, sub.selection!, ctx, childDefs);
          });
        } else if (sub.name === "pageInfo" && sub.selection) {
          ctx.actual += 1;
          conn["pageInfo"] = project("PageInfo", { hasNextPage: nodes.length > (n ?? 0), hasPreviousPage: false, startCursor: null, endCursor: null }, sub.selection, ctx, SCHEMA["PageInfo"]!);
        } else undefinedField(ctx, `${def.type}Connection`, sub.name);
      }
      out[field.name] = conn;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------ the server

export type Fault =
  | { kind: "throttle"; times: number; withCost?: boolean }
  | { kind: "status"; times: number; status: number; headers?: Record<string, string> }
  | { kind: "internal-error"; times: number }
  | { kind: "partial"; times: number }
  | { kind: "bad-json"; times: number }
  | { kind: "drop"; times: number }
  | { kind: "token-status"; times: number; status: number };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface MockShopifyOptions {
  /** Order nodes in the shape the client gets back (connections as { nodes: [...] }). */
  orders?: Array<Record<string, unknown>>;
  /** Access tokens the GraphQL endpoint accepts. */
  accessTokens?: string[];
  versions?: string[];
  bucket?: { maximumAvailable: number; restoreRate: number };
  maxQueryCost?: number;
  now?: () => number;
  shop?: { name: string; myshopifyDomain: string; ianaTimezone: string; currencyCode: string };
  app?: { clientId: string; clientSecret: string };
  /** Scopes the token endpoint grants. */
  grantedScopes?: string[];
}

export class MockShopify {
  readonly requests: RecordedRequest[] = [];
  readonly validTokens: Set<string>;
  readonly codes = new Map<string, { shop: string; used: boolean }>();
  readonly refreshTokens = new Map<string, { shop: string }>();
  orders: Array<Record<string, unknown>>;
  grantedScopes: string[];
  readonly options: MockShopifyOptions;
  private readonly versions: string[];
  private readonly faults: Fault[] = [];
  private readonly now: () => number;
  private bucketAvailable: number;
  private bucketAsOf: number;
  private readonly server: Server;
  port = 0;

  constructor(options: MockShopifyOptions = {}) {
    this.options = options;
    this.orders = options.orders ?? [];
    this.validTokens = new Set(options.accessTokens ?? ["shpat_test_token_not_real"]);
    this.versions = options.versions ?? ["2026-01", "2026-04", "2026-07", "2026-10"];
    this.now = options.now ?? Date.now;
    this.grantedScopes = options.grantedScopes ?? ["read_orders", "read_all_orders"];
    this.bucketAvailable = options.bucket?.maximumAvailable ?? 1000;
    this.bucketAsOf = this.now();
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
        try {
          this.route(req.method ?? "", req.url ?? "", req.headers, body, res);
        } catch (error) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(`mock server bug: ${error instanceof Error ? error.stack : String(error)}`);
        }
      });
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.port = await listenInRange(this.server);
    return this;
  }

  async stop(): Promise<void> {
    await closeServer(this.server);
  }

  inject(fault: Fault): void {
    this.faults.push(fault);
  }

  graphqlRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.includes("/graphql.json"));
  }

  issueAuthorizationCode(shop: string): string {
    const code = randomBytes(12).toString("hex");
    this.codes.set(code, { shop: shop.toLowerCase(), used: false });
    return code;
  }

  private takeFault<K extends Fault["kind"]>(...kinds: K[]): Extract<Fault, { kind: K }> | null {
    const idx = this.faults.findIndex((f) => (kinds as string[]).includes(f.kind));
    if (idx < 0) return null;
    const fault = this.faults[idx] as Extract<Fault, { kind: K }>;
    fault.times -= 1;
    if (fault.times <= 0) this.faults.splice(idx, 1);
    return fault;
  }

  private refill(): { max: number; rate: number } {
    const max = this.options.bucket?.maximumAvailable ?? 1000;
    const rate = this.options.bucket?.restoreRate ?? 100;
    const t = this.now();
    this.bucketAvailable = Math.min(max, this.bucketAvailable + ((t - this.bucketAsOf) / 1000) * rate);
    this.bucketAsOf = t;
    return { max, rate };
  }

  private route(method: string, url: string, headers: IncomingHttpHeaders, body: string, res: import("node:http").ServerResponse): void {
    const path = url.split("?")[0] ?? "";
    const gql = /^\/admin\/api\/([^/]+)\/graphql\.json$/.exec(path);
    if (method === "POST" && gql) return this.graphql(gql[1]!, headers, body, res);
    if (method === "POST" && path === "/admin/oauth/access_token") return this.token(body, res);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: "Not Found" }));
  }

  // ---- Admin GraphQL
  private graphql(requestedVersion: string, headers: IncomingHttpHeaders, body: string, res: import("node:http").ServerResponse): void {
    const json = (status: number, payload: unknown, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", "x-shopify-api-version": served, ...extra });
      res.end(JSON.stringify(payload));
    };
    // Docs: a version that is no longer served is answered with the oldest supported one; the header says which.
    const served = this.versions.includes(requestedVersion) ? requestedVersion : (this.versions[0] ?? requestedVersion);

    const tokenHeader = headers["x-shopify-access-token"];
    if (typeof tokenHeader !== "string" || !this.validTokens.has(tokenHeader)) return json(401, { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" });

    const status = this.takeFault("status");
    if (status) return json(status.status, { errors: `injected ${status.status}` }, status.headers ?? {});
    if (this.takeFault("drop")) return void res.destroy();
    if (this.takeFault("bad-json")) {
      res.writeHead(200, { "content-type": "application/json", "x-shopify-api-version": served });
      return void res.end("{not json");
    }
    const { max, rate } = this.refill();
    const status_ = (): { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } => ({ maximumAvailable: max, currentlyAvailable: Math.floor(this.bucketAvailable), restoreRate: rate });
    const throttle = this.takeFault("throttle");
    if (throttle) {
      return json(200, {
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        ...(throttle.withCost === false ? {} : { extensions: { cost: { requestedQueryCost: Math.max(101, Math.ceil(this.bucketAvailable) + 1), actualQueryCost: null, throttleStatus: { ...status_(), currentlyAvailable: Math.floor(this.bucketAvailable) } } } }),
      });
    }
    if (this.takeFault("internal-error")) {
      return json(200, { errors: [{ message: "Internal error. Looks like something went wrong on our end.", extensions: { code: "INTERNAL_SERVER_ERROR", requestId: "mock-request-id" } }] });
    }

    let parsed: { query?: string; variables?: Record<string, unknown> };
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { errors: "request body is not JSON" });
    }
    if (typeof parsed.query !== "string") return json(400, { errors: "no query" });
    const variables = parsed.variables ?? {};
    let selection: FieldNode[];
    try {
      selection = parseDocument(parsed.query);
    } catch (error) {
      return json(200, { errors: [{ message: `mock parser: ${(error as Error).message}`, extensions: { code: "parse_error" } }] });
    }

    const ctx: ExecCtx = { variables, errors: [], actual: 0 };
    const requested = requestedCost(selection, variables, ROOT);
    // validation pass first (undefined fields etc.) so a bad query is rejected without charging the bucket
    const data: Record<string, unknown> = {};
    for (const field of selection) {
      const def = ROOT[field.name];
      if (!def) {
        undefinedField(ctx, "QueryRoot", field.name);
        continue;
      }
      if (field.name === "shop") {
        ctx.actual += 1;
        data["shop"] = project("Shop", (this.options.shop ?? { name: "Harbour & Pine Goods", myshopifyDomain: "harbour-pine-demo.myshopify.com", ianaTimezone: "America/Toronto", currencyCode: "CAD" }) as Record<string, unknown>, field.selection ?? [], ctx, SCHEMA["Shop"]!);
      } else if (field.name === "orders") {
        const result = this.executeOrders(field, ctx);
        if (result) data["orders"] = result;
      }
    }
    if (ctx.errors.length > 0) return json(200, { errors: ctx.errors });

    const maxCost = this.options.maxQueryCost ?? 1000;
    if (requested > maxCost) {
      return json(200, {
        errors: [{ message: `Query cost is ${requested}, which exceeds the single query max cost limit (${maxCost}).`, extensions: { code: "MAX_COST_EXCEEDED", cost: requested, maxCost, documentation: "https://shopify.dev/api/usage/limits#rate-limits" } }],
      });
    }
    if (requested > this.bucketAvailable) {
      return json(200, {
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: requested, actualQueryCost: null, throttleStatus: status_() } },
      });
    }
    this.bucketAvailable -= requested;
    const actual = Math.min(requested, ctx.actual);
    this.bucketAvailable = Math.min(max, this.bucketAvailable + (requested - actual)); // refund the difference
    const extensions = { cost: { requestedQueryCost: requested, actualQueryCost: actual, throttleStatus: status_() } };

    if (this.takeFault("partial")) {
      // data for some of the result plus an error, as GraphQL allows
      const orders = data["orders"] as { nodes?: Array<Record<string, unknown>> } | undefined;
      if (orders?.nodes && orders.nodes.length > 0) orders.nodes[orders.nodes.length - 1] = null as unknown as Record<string, unknown>;
      return json(200, { data, errors: [{ message: "Something went wrong while resolving an order", path: ["orders", "nodes", Math.max(0, (orders?.nodes?.length ?? 1) - 1)] }], extensions });
    }
    return json(200, { data, extensions });
  }

  private executeOrders(field: FieldNode, ctx: ExecCtx): Record<string, unknown> | null {
    const args = parseArgs(field.args, ctx.variables);
    const sortKey = typeof args["sortKey"] === "string" ? args["sortKey"] : "PROCESSED_AT";
    if (!ORDER_SORT_KEYS.includes(sortKey)) {
      ctx.errors.push({ message: `Argument 'sortKey' on Field 'orders' has an invalid value (${sortKey})`, extensions: { code: "argumentLiteralsIncompatible" } });
      return null;
    }
    let list = [...this.orders];
    const search = typeof args["query"] === "string" ? args["query"] : "";
    // the only search terms the mock understands: updated_at:>='…', processed_at:>='…' (and <, <=, >), test:true|false
    let rest = search;
    for (const m of search.matchAll(/(updated_at|processed_at|created_at):(>=|<=|>|<)?'([^']+)'/g)) {
      const [whole, fieldName, op = "=", value] = m as unknown as [string, string, string, string];
      rest = rest.replace(whole, "");
      const key = fieldName === "updated_at" ? "updatedAt" : fieldName === "processed_at" ? "processedAt" : "createdAt";
      const bound = Date.parse(value);
      list = list.filter((o) => {
        const v = Date.parse(String(o[key]));
        return op === ">=" ? v >= bound : op === "<=" ? v <= bound : op === ">" ? v > bound : op === "<" ? v < bound : v === bound;
      });
    }
    for (const m of search.matchAll(/\btest:(true|false)\b/g)) {
      rest = rest.replace(m[0], "");
      list = list.filter((o) => Boolean(o["test"]) === (m[1] === "true"));
    }
    if (rest.trim() !== "") {
      ctx.errors.push({ message: `mock search does not understand: ${rest.trim()}`, extensions: { code: "mock_unsupported_search" } });
      return null;
    }
    const sortField = sortKey === "UPDATED_AT" ? "updatedAt" : sortKey === "CREATED_AT" ? "createdAt" : "processedAt";
    list.sort((a, b) => Date.parse(String(a[sortField])) - Date.parse(String(b[sortField])) || String(a["id"]).localeCompare(String(b["id"])));
    if (args["reverse"] === true) list.reverse();

    let start = 0;
    if (typeof args["after"] === "string") {
      try {
        start = (JSON.parse(Buffer.from(args["after"], "base64url").toString("utf8")) as { i: number }).i + 1;
      } catch {
        ctx.errors.push({ message: "Invalid cursor", extensions: { code: "invalid_cursor" } });
        return null;
      }
    }
    const first = firstArg(args);
    if (first === undefined) {
      ctx.errors.push({ message: "you must provide a `first` or `last` value to properly paginate the `orders` connection.", extensions: { code: "missingPaginationBoundaries" } });
      return null;
    }
    if (first > 250) {
      ctx.errors.push({ message: "Requesting more than 250 objects is not allowed for `orders`", extensions: { code: "MAX_PAGE_SIZE_EXCEEDED" } });
      return null;
    }
    const page = list.slice(start, start + first);
    const hasNext = start + first < list.length;
    const endIndex = start + page.length - 1;
    const endCursor = page.length > 0 ? Buffer.from(JSON.stringify({ i: endIndex })).toString("base64url") : null;
    // project through a one-connection wrapper so nested validation and cost accounting reuse the same code
    const wrapper = { orders: { nodes: page } };
    const projected = project("Query", wrapper, [{ ...field, args: `first: ${first}` }], ctx, { orders: ROOT["orders"]! });
    const out = projected["orders"] as Record<string, unknown>;
    if (out && "pageInfo" in out) {
      const pi = out["pageInfo"] as Record<string, unknown>;
      if ("hasNextPage" in pi) pi["hasNextPage"] = hasNext;
      if ("endCursor" in pi) pi["endCursor"] = endCursor;
      if ("hasPreviousPage" in pi) pi["hasPreviousPage"] = start > 0;
    }
    return out;
  }

  // ---- OAuth token endpoint
  private token(body: string, res: import("node:http").ServerResponse): void {
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const injected = this.takeFault("token-status");
    if (injected) return send(injected.status, { error: "injected" });
    const form = new URLSearchParams(body);
    const app = this.options.app ?? { clientId: "test_client_id", clientSecret: "test_client_secret_not_real_0123456789" };
    if (form.get("client_id") !== app.clientId || form.get("client_secret") !== app.clientSecret) return send(403, { error: "invalid_client" });
    const expiring = form.get("expiring") === "1";
    const issue = (shop: string): Record<string, unknown> => {
      const accessToken = `shpat_${randomBytes(12).toString("hex")}`;
      this.validTokens.add(accessToken);
      const out: Record<string, unknown> = { access_token: accessToken, scope: this.grantedScopes.join(",") };
      if (expiring) {
        const refresh = `shprt_${randomBytes(12).toString("hex")}`;
        this.refreshTokens.set(refresh, { shop });
        Object.assign(out, { expires_in: 3600, refresh_token: refresh, refresh_token_expires_in: 7776000 });
      }
      return out;
    };
    if (form.get("grant_type") === "refresh_token") {
      const old = form.get("refresh_token") ?? "";
      const entry = this.refreshTokens.get(old);
      if (!entry) return send(401, { error: "invalid_request", error_description: "This request requires an active refresh_token" });
      this.refreshTokens.delete(old); // rotation: the presented token is retired
      const out = issue(entry.shop);
      if (!out["refresh_token"]) {
        const refresh = `shprt_${randomBytes(12).toString("hex")}`;
        this.refreshTokens.set(refresh, entry);
        Object.assign(out, { expires_in: 3600, refresh_token: refresh, refresh_token_expires_in: 7776000 });
      }
      return send(200, out);
    }
    const code = form.get("code") ?? "";
    const entry = this.codes.get(code);
    if (!entry || entry.used) return send(400, { error: "invalid_request" }); // docs: invalid `code` -> 400
    entry.used = true;
    return send(200, issue(entry.shop));
  }
}
