// SQLite schema (node:sqlite, built into Node; nothing to install). One file, or ":memory:" in tests.
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_webhooks (
  key         TEXT PRIMARY KEY,                 -- dedupe key (X-Shopify-Webhook-Id by default)
  status      TEXT NOT NULL CHECK (status IN ('in_flight','done','failed')),
  topic       TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  locked_at   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS compliance_requests (
  webhook_id     TEXT PRIMARY KEY,              -- one row per delivery; a re-delivery cannot create a second row
  event_id       TEXT,
  topic          TEXT NOT NULL CHECK (topic IN ('customers/data_request','customers/redact','shop/redact')),
  shop_domain    TEXT NOT NULL,
  shop_id        TEXT,                          -- ids are kept as digit strings: Shopify ids can exceed 2^53
  customer_id    TEXT,
  customer_email TEXT,
  payload        TEXT NOT NULL,                 -- the verified body, verbatim
  received_at    INTEGER NOT NULL,
  due_at         INTEGER NOT NULL,              -- docs: complete the action within 30 days of receiving the request
  status         TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','completed','failed')),
  completed_at   INTEGER,
  result         TEXT
);

CREATE TABLE IF NOT EXISTS shops (
  shop_domain              TEXT PRIMARY KEY,
  access_token             TEXT NOT NULL,
  scope                    TEXT NOT NULL,
  expires_at               INTEGER,
  refresh_token            TEXT,
  refresh_token_expires_at INTEGER,
  installed_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders_seen (
  shop_domain      TEXT NOT NULL,
  order_id         TEXT NOT NULL,
  name             TEXT,
  updated_at_ms    INTEGER NOT NULL,            -- newest updated_at applied so far
  created_at       TEXT,
  processed_at     TEXT,
  cancelled_at     TEXT,                        -- once set, never cleared by a later or earlier event
  financial_status TEXT,
  test             INTEGER NOT NULL DEFAULT 0,
  currency         TEXT,
  total_price      TEXT,
  customer_id      TEXT,
  email            TEXT,
  redacted         INTEGER NOT NULL DEFAULT 0,
  last_topic       TEXT,
  last_event_id    TEXT,
  PRIMARY KEY (shop_domain, order_id)
);

CREATE TABLE IF NOT EXISTS refunds_seen (
  shop_domain  TEXT NOT NULL,
  refund_id    TEXT NOT NULL,
  order_id     TEXT NOT NULL,                   -- no foreign key: a refund can arrive before its order
  processed_at TEXT,
  PRIMARY KEY (shop_domain, refund_id)
);
`;

export function openDb(path = ":memory:"): Db {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

/** Runs `fn` in a transaction; a throw rolls everything back. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
