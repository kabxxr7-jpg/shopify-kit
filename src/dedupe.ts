// Webhook de-duplication. Shopify says it "minimizes duplicate deliveries" but they happen (timeouts, retries),
// and recommends: extract X-Shopify-Webhook-Id, check a persistent store, skip and answer success if it exists,
// otherwise process and save the id. This store adds the two states a real worker needs:
//   in_flight  claimed, handler running (a second delivery meanwhile gets 409 so Shopify retries later)
//   done       handled; further deliveries are acknowledged and skipped
//   failed     handler threw; the next delivery may claim it again (Shopify retries 8 times over 4 hours)
// A claim older than lockTimeoutMs is treated as a crashed worker and can be taken over.
import type { Db } from "./db.ts";

export type ClaimResult = "claimed" | "done" | "in_flight";

export interface DedupeStore {
  claim(key: string, meta: { topic: string; shopDomain: string }): Promise<ClaimResult>;
  complete(key: string): Promise<void>;
  fail(key: string, error: string): Promise<void>;
}

export interface DedupeOptions {
  lockTimeoutMs?: number;
  now?: () => number;
}

export function createMemoryStore(options: DedupeOptions = {}): DedupeStore {
  const lockTimeoutMs = options.lockTimeoutMs ?? 5 * 60_000;
  const now = options.now ?? Date.now;
  const rows = new Map<string, { status: "in_flight" | "done" | "failed"; lockedAt: number }>();
  return {
    async claim(key) {
      const row = rows.get(key);
      if (!row) {
        rows.set(key, { status: "in_flight", lockedAt: now() });
        return "claimed";
      }
      if (row.status === "done") return "done";
      if (row.status === "failed" || now() - row.lockedAt > lockTimeoutMs) {
        rows.set(key, { status: "in_flight", lockedAt: now() });
        return "claimed";
      }
      return "in_flight";
    },
    async complete(key) {
      const row = rows.get(key);
      if (row) rows.set(key, { status: "done", lockedAt: row.lockedAt }); // like the SQL UPDATE: a key nobody claimed stays unknown
    },
    async fail(key) {
      const row = rows.get(key);
      if (row && row.status !== "done") rows.set(key, { status: "failed", lockedAt: row.lockedAt });
    },
  };
}

export function createSqliteStore(params: { db: Db } & DedupeOptions): DedupeStore {
  const { db } = params;
  const lockTimeoutMs = params.lockTimeoutMs ?? 5 * 60_000;
  const now = params.now ?? Date.now;
  const insert = db.prepare(
    `INSERT INTO processed_webhooks (key, status, topic, shop_domain, locked_at, updated_at)
     VALUES (?, 'in_flight', ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = 'in_flight', locked_at = excluded.locked_at, updated_at = excluded.updated_at, error = NULL
       WHERE processed_webhooks.status = 'failed' OR (processed_webhooks.status = 'in_flight' AND processed_webhooks.locked_at < ?)`,
  );
  const read = db.prepare("SELECT status FROM processed_webhooks WHERE key = ?");
  const done = db.prepare("UPDATE processed_webhooks SET status = 'done', updated_at = ?, error = NULL WHERE key = ?");
  const failed = db.prepare("UPDATE processed_webhooks SET status = 'failed', updated_at = ?, error = ? WHERE key = ? AND status <> 'done'");
  return {
    async claim(key, meta) {
      const t = now();
      const { changes } = insert.run(key, meta.topic, meta.shopDomain, t, t, t - lockTimeoutMs);
      if (Number(changes) === 1) return "claimed";
      const row = read.get(key) as { status: string } | undefined;
      return row?.status === "done" ? "done" : "in_flight";
    },
    async complete(key) {
      done.run(now(), key);
    },
    async fail(key, error) {
      failed.run(now(), error.slice(0, 500), key);
    },
  };
}
