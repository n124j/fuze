import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { JobQueue } from "../src/queue/queue.js";

let db: Db;
let t: number;
let q: JobQueue;
beforeEach(() => {
  db = openDb(":memory:");
  t = 1_000_000;
  q = new JobQueue(db, () => t);
});

describe("JobQueue claim order", () => {
  it("hands out jobs oldest first and then nothing", () => {
    const a = q.enqueue("x", { n: 1 });
    t += 1;
    const b = q.enqueue("x", { n: 2 });
    expect(q.claim()?.id).toBe(a);
    expect(q.claim()?.id).toBe(b);
    expect(q.claim()).toBeNull();
  });

  it("does not hand out a job before its runAfter time", () => {
    const id = q.enqueue("x", {}, { runAfter: t + 5000 });
    expect(q.claim()).toBeNull();
    t += 5000;
    expect(q.claim()?.id).toBe(id);
  });

  it("round-trips the payload and starts with no checkpoint", () => {
    q.enqueue("x", { deep: { list: [1, 2] } });
    const job = q.claim()!;
    expect(job.payload).toEqual({ deep: { list: [1, 2] } });
    expect(job.checkpoint).toBeNull();
    expect(job.status).toBe("running");
    expect(job.type).toBe("x");
  });

  it("does not hand a running or finished job to a second claimer", () => {
    q.enqueue("x", {});
    const job = q.claim()!;
    expect(q.claim()).toBeNull();
    q.complete(job.id);
    expect(q.claim()).toBeNull();
    expect(q.get(job.id)?.status).toBe("done");
  });
});

describe("JobQueue dedupe", () => {
  it("returns the existing job for the same dedupeKey", () => {
    const a = q.enqueue("briefing", {}, { dedupeKey: "briefing:2026-11-20" });
    const b = q.enqueue("briefing", {}, { dedupeKey: "briefing:2026-11-20" });
    expect(b).toBe(a);
  });

  it("still dedupes after the job finished, so a day's briefing is never queued twice", () => {
    const a = q.enqueue("briefing", {}, { dedupeKey: "k" });
    q.complete(q.claim()!.id);
    expect(q.enqueue("briefing", {}, { dedupeKey: "k" })).toBe(a);
  });

  it("allows the key again once the earlier job has failed for good", () => {
    const a = q.enqueue("x", {}, { dedupeKey: "k", maxAttempts: 1 });
    q.fail(q.claim()!.id, "boom");
    expect(q.get(a)?.status).toBe("failed");
    expect(q.enqueue("x", {}, { dedupeKey: "k" })).not.toBe(a);
  });
});

describe("JobQueue failure handling", () => {
  it("retries with growing backoff, then fails for good after maxAttempts", () => {
    const id = q.enqueue("x", {}, { maxAttempts: 3 });
    q.fail(q.claim()!.id, "e1");
    expect(q.get(id)).toMatchObject({ status: "queued", attempts: 1, runAfter: t + 1000 });
    expect(q.claim()).toBeNull();
    t += 1000;
    q.fail(q.claim()!.id, "e2");
    expect(q.get(id)).toMatchObject({ status: "queued", attempts: 2, runAfter: t + 2000 });
    t += 2000;
    q.fail(q.claim()!.id, "e3");
    expect(q.get(id)).toMatchObject({ status: "failed", attempts: 3 });
    expect(q.claim()).toBeNull();
  });

  it("fails immediately when told the failure is final", () => {
    const id = q.enqueue("x", {}, { maxAttempts: 5 });
    q.fail(q.claim()!.id, "cannot be retried", { final: true });
    expect(q.get(id)?.status).toBe("failed");
  });

  it("defers without counting an attempt", () => {
    const id = q.enqueue("x", {});
    q.defer(q.claim()!.id, t + 60_000);
    expect(q.get(id)).toMatchObject({ status: "queued", attempts: 0, runAfter: t + 60_000 });
    expect(q.claim()).toBeNull();
    t += 60_000;
    expect(q.claim()?.id).toBe(id);
  });
});

describe("JobQueue checkpoints and stale recovery", () => {
  it("keeps a checkpoint that a re-claimed job can see", () => {
    const id = q.enqueue("x", {});
    q.saveCheckpoint(q.claim()!.id, { done: ["a", "b"] });
    t += 10_000;
    expect(q.recoverStale(5000)).toBe(1);
    const again = q.claim()!;
    expect(again.id).toBe(id);
    expect(again.checkpoint).toEqual({ done: ["a", "b"] });
  });

  it("leaves a recently claimed job alone", () => {
    q.enqueue("x", {});
    q.claim();
    t += 1000;
    expect(q.recoverStale(5000)).toBe(0);
    expect(q.claim()).toBeNull();
  });

  it("stops requeueing a job that keeps dying", () => {
    const id = q.enqueue("x", {}, { maxAttempts: 2 });
    for (let i = 0; i < 2; i++) {
      q.claim();
      t += 10_000;
      q.recoverStale(5000);
      t += 10_000; // clear any backoff
    }
    expect(q.get(id)?.status).toBe("failed");
  });
});
