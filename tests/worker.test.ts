import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError } from "../src/budget/guard.js";
import { openDb, type Db } from "../src/db.js";
import { runOnce } from "../src/idempotency.js";
import { JobQueue } from "../src/queue/queue.js";
import { Worker, type Handler } from "../src/queue/worker.js";

let db: Db;
let t: number;
let q: JobQueue;
beforeEach(() => {
  db = openDb(":memory:");
  t = 1_000_000;
  q = new JobQueue(db, () => t);
});

const worker = (handlers: Record<string, Handler>, onBudgetPause = () => t + 3_600_000) =>
  new Worker(q, handlers, { pollMs: 5, staleMs: 5000, onBudgetPause });

describe("Worker.tick", () => {
  it("runs the handler for a job and marks it done", async () => {
    const seen: unknown[] = [];
    const id = q.enqueue("hello", { who: "owner" });
    const ran = await worker({ hello: async (job) => void seen.push(job.payload) }).tick();
    expect(ran).toBe(true);
    expect(seen).toEqual([{ who: "owner" }]);
    expect(q.get(id)?.status).toBe("done");
  });

  it("returns false when there is nothing to do", async () => {
    expect(await worker({}).tick()).toBe(false);
  });

  it("fails and retries a job whose handler throws", async () => {
    const id = q.enqueue("bad", {});
    await worker({ bad: async () => { throw new Error("nope"); } }).tick();
    expect(q.get(id)).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("fails a job with no handler immediately", async () => {
    const id = q.enqueue("mystery", {});
    await worker({}).tick();
    expect(q.get(id)?.status).toBe("failed");
  });

  it("pauses a job until the budget resets instead of failing it", async () => {
    const id = q.enqueue("llm", {});
    const resume = t + 9_000_000;
    await worker(
      { llm: async () => { throw new BudgetExhaustedError(); } },
      () => resume,
    ).tick();
    expect(q.get(id)).toMatchObject({ status: "queued", attempts: 0, runAfter: resume });
  });

  it("does not retry an action that may already have happened", async () => {
    db.prepare("INSERT INTO idempotency(key,status,created_at) VALUES ('send:1','started',1)").run();
    const id = q.enqueue("send", {});
    await worker({ send: async () => { await runOnce(db, "send:1", async () => "sent"); } }).tick();
    expect(q.get(id)?.status).toBe("failed");
  });

  it("saves checkpoints through the handler context", async () => {
    const id = q.enqueue("research", {});
    await worker({
      research: async (_job, ctx) => {
        ctx.checkpoint({ companiesDone: 6 });
        throw new Error("worker crashed");
      },
    }).tick();
    expect(q.get(id)?.checkpoint).toEqual({ companiesDone: 6 });
  });
});

describe("Worker crash recovery", () => {
  it("resumes a job killed mid-run from its last checkpoint", async () => {
    const id = q.enqueue("research", {});
    const dying = q.claim()!; // a worker picks it up...
    q.saveCheckpoint(dying.id, { companiesDone: 6 }); // ...makes progress...
    t += 10_000; // ...and the process dies without finishing

    let resumedFrom: unknown;
    await worker({ research: async (job) => void (resumedFrom = job.checkpoint) }).tick();
    expect(resumedFrom).toEqual({ companiesDone: 6 });
    expect(q.get(id)?.status).toBe("done");
  });

  it("does not repeat a side effect that ran before the worker died", async () => {
    let emailsSent = 0;
    const sendOnce = (): Promise<void> =>
      runOnce(db, "email:client-42", async () => {
        emailsSent++;
      });

    const id = q.enqueue("reply", {});
    q.claim(); // worker picks the job up
    await sendOnce(); // the side effect happens and is recorded...
    t += 10_000; // ...then the worker dies before marking the job done

    await worker({ reply: async () => sendOnce() }).tick();
    expect(emailsSent).toBe(1);
    expect(q.get(id)?.status).toBe("done");
  });
});

describe("Worker.start / stop", () => {
  it("processes queued jobs in the background and stops cleanly", async () => {
    const handled = vi.fn(async () => {});
    const w = worker({ ping: handled });
    w.start();
    const id = q.enqueue("ping", {});
    await vi.waitFor(() => expect(q.get(id)?.status).toBe("done"), { timeout: 2000 });
    await w.stop();
    expect(handled).toHaveBeenCalledTimes(1);
  });
});
