import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  type: string;
  payload: unknown;
  checkpoint: unknown | null;
  status: JobStatus;
  /** Failed or crashed runs so far; a budget pause does not count. */
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  lockedAt: number | null;
}

interface Row {
  id: string;
  type: string;
  payload: string;
  checkpoint: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: number;
  locked_at: number | null;
}

const BASE_BACKOFF_MS = 1000;

function toJob(r: Row): Job {
  return {
    id: r.id,
    type: r.type,
    payload: JSON.parse(r.payload),
    checkpoint: r.checkpoint === null ? null : JSON.parse(r.checkpoint),
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAfter: r.run_after,
    lockedAt: r.locked_at,
  };
}

export interface EnqueueOptions {
  runAfter?: number;
  maxAttempts?: number;
  /** A job with the same key that has not failed for good is returned instead of adding another. */
  dedupeKey?: string;
}

/** SQLite-backed job queue for one process: claim, checkpoint, retry with backoff, recover from crashes. */
export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}): string {
    return this.db.transaction((): string => {
      if (opts.dedupeKey !== undefined) {
        const existing = this.db
          .prepare("SELECT id FROM jobs WHERE dedupe_key = ? AND status != 'failed'")
          .get(opts.dedupeKey) as { id: string } | undefined;
        if (existing) return existing.id;
      }
      const id = randomUUID();
      const now = this.clock();
      this.db
        .prepare(
          `INSERT INTO jobs (id, type, payload, status, max_attempts, run_after, dedupe_key, created_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(id, type, JSON.stringify(payload), opts.maxAttempts ?? 3, opts.runAfter ?? now, opts.dedupeKey ?? null, now);
      return id;
    })();
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  /** Take the oldest job that is due and mark it running; null when nothing is due. */
  claim(): Job | null {
    return this.db.transaction((): Job | null => {
      const now = this.clock();
      const row = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ?
           ORDER BY run_after, created_at, rowid LIMIT 1`,
        )
        .get(now) as Row | undefined;
      if (!row) return null;
      this.db.prepare("UPDATE jobs SET status = 'running', locked_at = ? WHERE id = ?").run(now, row.id);
      return toJob({ ...row, status: "running", locked_at: now });
    })();
  }

  saveCheckpoint(id: string, checkpoint: unknown): void {
    this.db.prepare("UPDATE jobs SET checkpoint = ? WHERE id = ?").run(JSON.stringify(checkpoint), id);
  }

  complete(id: string): void {
    this.db.prepare("UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = ?").run(id);
  }

  /** Count a failed run: retry with exponential backoff, or fail for good at maxAttempts (or when `final`). */
  fail(id: string, error: string, opts: { final?: boolean } = {}): void {
    const row = this.db.prepare("SELECT attempts, max_attempts FROM jobs WHERE id = ?").get(id) as
      | { attempts: number; max_attempts: number }
      | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    if (opts.final || attempts >= row.max_attempts) {
      this.db
        .prepare("UPDATE jobs SET status = 'failed', attempts = ?, last_error = ?, locked_at = NULL WHERE id = ?")
        .run(attempts, error, id);
      return;
    }
    const runAfter = this.clock() + BASE_BACKOFF_MS * 2 ** (attempts - 1);
    this.db
      .prepare(
        "UPDATE jobs SET status = 'queued', attempts = ?, last_error = ?, run_after = ?, locked_at = NULL WHERE id = ?",
      )
      .run(attempts, error, runAfter, id);
  }

  /** Put a running job back to wait until `runAfter`, without counting an attempt. */
  defer(id: string, runAfter: number): void {
    this.db
      .prepare("UPDATE jobs SET status = 'queued', run_after = ?, locked_at = NULL WHERE id = ?")
      .run(runAfter, id);
  }

  /**
   * Requeue jobs left running longer than `timeoutMs` (their worker died). Each recovery counts as an
   * attempt so a job that keeps killing its worker eventually fails. Returns how many were requeued.
   */
  recoverStale(timeoutMs: number): number {
    return this.db.transaction((): number => {
      const now = this.clock();
      const stale = this.db
        .prepare("SELECT id, attempts, max_attempts FROM jobs WHERE status = 'running' AND locked_at < ?")
        .all(now - timeoutMs) as { id: string; attempts: number; max_attempts: number }[];
      let requeued = 0;
      for (const job of stale) {
        const attempts = job.attempts + 1;
        if (attempts >= job.max_attempts) {
          this.db
            .prepare(
              "UPDATE jobs SET status = 'failed', attempts = ?, last_error = 'worker died', locked_at = NULL WHERE id = ?",
            )
            .run(attempts, job.id);
        } else {
          this.db
            .prepare("UPDATE jobs SET status = 'queued', attempts = ?, run_after = ?, locked_at = NULL WHERE id = ?")
            .run(attempts, now, job.id);
          requeued++;
        }
      }
      return requeued;
    })();
  }
}
