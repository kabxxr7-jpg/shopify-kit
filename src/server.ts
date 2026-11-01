// A small node:http server around the pieces: GET /health, POST /webhooks (raw body, size limit, the receiver),
// and - when OAuth is configured - GET /auth/install and GET /auth/callback. It exists so the whole flow can be
// run and tested end to end locally; in a real app you would mount the same functions in your framework.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Db } from "./db.ts";
import { beginInstall, handleCallback, STATE_COOKIE_NAME, type NonceStore, type OAuthConfig } from "./oauth.ts";
import { handleShopifyWebhook, type WebhookOptions } from "./webhooks.ts";

export interface AppServerConfig {
  webhook: WebhookOptions;
  webhookPath?: string;
  /** Default 5 MiB. The docs read give no maximum payload size. */
  maxBodyBytes?: number;
  oauth?: { config: OAuthConfig; nonces: NonceStore; db: Db; installPath?: string; callbackPath?: string };
  /** One JSON line per request; never contains payloads, secrets or tokens. */
  log?: (line: string) => void;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0; // stop buffering, keep draining so the response can be written
        return;
      }
      if (!over) chunks.push(chunk);
    });
    req.on("end", () => resolve(over ? "too_large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export function createAppServer(config: AppServerConfig): Server {
  const webhookPath = config.webhookPath ?? "/webhooks";
  const limit = config.maxBodyBytes ?? 5 * 1024 * 1024;
  const log = config.log ?? (() => {});
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

        if (url.pathname === webhookPath) {
          if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
          const body = await readBody(req, limit);
          if (body === "too_large") return send(res, 413, { error: "payload_too_large" });
          const result = await handleShopifyWebhook({ rawBody: new Uint8Array(body), headers: req.headers }, config.webhook);
          log(JSON.stringify({ at: "webhook", status: result.status, reason: result.reason, topic: req.headers["x-shopify-topic"], shop: req.headers["x-shopify-shop-domain"], error: result.error }));
          return send(res, result.status, result.body);
        }

        const oauth = config.oauth;
        if (oauth && req.method === "GET" && url.pathname === (oauth.installPath ?? "/auth/install")) {
          const start = beginInstall(oauth.config, { shop: url.searchParams.get("shop") ?? undefined }, oauth.nonces);
          if (!start.ok) return send(res, start.status, { error: start.reason });
          res.writeHead(302, { location: start.redirectUrl, "set-cookie": start.setCookie });
          return void res.end();
        }
        if (oauth && req.method === "GET" && url.pathname === (oauth.callbackPath ?? "/auth/callback")) {
          const result = await handleCallback(oauth.config, { query: url.searchParams, stateCookie: cookieValue(req.headers.cookie, STATE_COOKIE_NAME), nonces: oauth.nonces });
          const clearCookie = `${STATE_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
          if (!result.ok) {
            log(JSON.stringify({ at: "oauth_callback", status: result.status, reason: result.reason, detail: result.detail }));
            return send(res, result.status, { error: result.reason }, { "set-cookie": clearCookie });
          }
          const t = result.tokens;
          oauth.db
            .prepare(
              `INSERT INTO shops (shop_domain, access_token, scope, expires_at, refresh_token, refresh_token_expires_at, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(shop_domain) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope, expires_at = excluded.expires_at,
                 refresh_token = excluded.refresh_token, refresh_token_expires_at = excluded.refresh_token_expires_at, installed_at = excluded.installed_at`,
            )
            .run(result.shop, t.accessToken, t.scope.join(","), t.expiresAt ?? null, t.refreshToken ?? null, t.refreshTokenExpiresAt ?? null, Date.now());
          log(JSON.stringify({ at: "oauth_callback", status: 200, shop: result.shop, scopes: t.scope }));
          return send(res, 200, { installed: true, shop: result.shop }, { "set-cookie": clearCookie });
        }
        return send(res, 404, { error: "not_found" });
      } catch (error) {
        log(JSON.stringify({ at: "server_error", error: error instanceof Error ? error.message : String(error) }));
        if (!res.headersSent) send(res, 500, { error: "internal_error" });
        else res.end();
      }
    })();
  });
  // Shopify's delivery system reuses connections (HTTP Keep-Alive); keep idle sockets open longer than a typical load balancer does.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  return server;
}
