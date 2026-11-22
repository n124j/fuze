import Database from "better-sqlite3";

export type Db = Database.Database;

/** Append-only list: never edit an entry that has shipped, add a new one. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    checkpoint TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    run_after INTEGER NOT NULL,
    locked_at INTEGER,
    dedupe_key TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX jobs_dedupe ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status != 'failed';
  CREATE INDEX jobs_ready ON jobs(status, run_after);

  CREATE TABLE idempotency (
    key TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    priority TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sent_at INTEGER
  );

  CREATE TABLE budget_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date_key TEXT NOT NULL,
    model TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX budget_usage_date ON budget_usage(date_key);

  CREATE TABLE budget_notice (date_key TEXT PRIMARY KEY);

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    history_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    UNIQUE (channel, chat_id)
  );

  CREATE TABLE owner_identities (
    channel TEXT NOT NULL,
    channel_user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    paired_at INTEGER NOT NULL,
    PRIMARY KEY (channel, channel_user_id)
  );

  CREATE TABLE pairing (
    code TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE seen_items (
    source TEXT NOT NULL,
    id TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (source, id)
  );

  CREATE TABLE connector_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  `,
  `
  CREATE TABLE trash_requests (
    id TEXT PRIMARY KEY,
    query TEXT NOT NULL,
    ids_json TEXT NOT NULL,
    count INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`database schema v${current} is newer than this build (v${SCHEMA_VERSION})`);
  }
  for (let i = current; i < SCHEMA_VERSION; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return db;
}
