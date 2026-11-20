import type { Db } from "./db.js";

/** Thrown when an action was started earlier but never recorded as finished: repeating it could duplicate a side effect. */
export class AmbiguousActionError extends Error {
  constructor(public readonly key: string) {
    super(`action "${key}" was started but never finished; refusing to repeat it`);
    this.name = "AmbiguousActionError";
  }
}

/**
 * Run `fn` at most once for `key`. A finished key returns its stored result (an
 * undefined or null result reads back as undefined). A key left "started" by a
 * crash raises AmbiguousActionError. If `fn` throws, the claim is released so a retry may run.
 */
export async function runOnce<T>(db: Db, key: string, fn: () => Promise<T>): Promise<T> {
  const existing = db.prepare("SELECT status, result FROM idempotency WHERE key = ?").get(key) as
    | { status: string; result: string | null }
    | undefined;
  if (existing) {
    if (existing.status !== "done") throw new AmbiguousActionError(key);
    return (existing.result === null ? undefined : JSON.parse(existing.result)) as T;
  }

  const claimed = db
    .prepare("INSERT OR IGNORE INTO idempotency(key, status, created_at) VALUES (?, 'started', ?)")
    .run(key, Date.now());
  if (claimed.changes === 0) throw new AmbiguousActionError(key);

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    db.prepare("DELETE FROM idempotency WHERE key = ?").run(key);
    throw err;
  }
  db.prepare("UPDATE idempotency SET status = 'done', result = ? WHERE key = ?").run(
    result === undefined ? null : JSON.stringify(result),
    key,
  );
  return result;
}
