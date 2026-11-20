import { BudgetExhaustedError } from "../budget/guard.js";
import { AmbiguousActionError } from "../idempotency.js";
import type { Job, JobQueue } from "./queue.js";

export interface HandlerContext {
  /** Save progress so a re-run after a crash can pick up where this one stopped. */
  checkpoint(cp: unknown): void;
}

export type Handler = (job: Job, ctx: HandlerContext) => Promise<void>;

export interface WorkerOptions {
  pollMs: number;
  /** A job running longer than this is assumed to belong to a dead worker. */
  staleMs: number;
  /** When the LLM budget runs out mid-job: the time (ms epoch) at which to try again. */
  onBudgetPause: () => number;
}

/** Runs one job at a time from the queue. */
export class Worker {
  private stopped = true;
  private loop: Promise<void> = Promise.resolve();
  private sleeper: { timer: NodeJS.Timeout; wake: () => void } | null = null;

  constructor(
    private readonly queue: JobQueue,
    private readonly handlers: Record<string, Handler>,
    private readonly opts: WorkerOptions,
  ) {}

  /** Recover stale jobs, then run at most one due job. Returns whether a job was run. */
  async tick(): Promise<boolean> {
    this.queue.recoverStale(this.opts.staleMs);
    const job = this.queue.claim();
    if (!job) return false;

    const handler = this.handlers[job.type];
    if (!handler) {
      this.queue.fail(job.id, `no handler for job type "${job.type}"`, { final: true });
      return true;
    }
    try {
      await handler(job, { checkpoint: (cp) => this.queue.saveCheckpoint(job.id, cp) });
      this.queue.complete(job.id);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        this.queue.defer(job.id, this.opts.onBudgetPause());
      } else if (err instanceof AmbiguousActionError) {
        // The action may already have happened; retrying could repeat it.
        this.queue.fail(job.id, err.message, { final: true });
      } else {
        this.queue.fail(job.id, err instanceof Error ? err.message : String(err));
      }
    }
    return true;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sleeper) {
      clearTimeout(this.sleeper.timer);
      this.sleeper.wake();
    }
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let didWork = false;
      try {
        didWork = await this.tick();
      } catch (err) {
        console.error("[worker] tick failed:", err instanceof Error ? err.message : err);
      }
      if (!didWork && !this.stopped) await this.sleep(this.opts.pollMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sleeper = null;
        resolve();
      }, ms);
      this.sleeper = {
        timer,
        wake: () => {
          this.sleeper = null;
          resolve();
        },
      };
    });
  }
}
