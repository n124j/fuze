import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, SCHEMA_VERSION } from "../src/db.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe("openDb", () => {
  it("creates every table the app needs and records the schema version", () => {
    const db = openDb(":memory:");
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        "jobs",
        "idempotency",
        "notifications",
        "budget_usage",
        "budget_notice",
        "sessions",
        "owner_identities",
        "pairing",
        "seen_items",
        "connector_state",
        "approvals",
      ]),
    );
    expect(SCHEMA_VERSION).toBe(3);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("is idempotent on an existing file and keeps its data", () => {
    const dir = mkdtempSync(join(tmpdir(), "fuse-db-"));
    dirs.push(dir);
    const file = join(dir, "fuse.db");
    const first = openDb(file);
    first.prepare("INSERT INTO idempotency(key,status,created_at) VALUES ('k','done',1)").run();
    first.close();
    const second = openDb(file);
    expect(second.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(second.prepare("SELECT key FROM idempotency").all()).toEqual([{ key: "k" }]);
    second.close();
  });
});
