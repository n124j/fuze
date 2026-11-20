import { Cron } from "croner";
import type { Config } from "./config.js";
import type { JobQueue } from "./queue/queue.js";
import { localDateKey } from "./time.js";

const HEARTBEAT_MS = 30 * 60 * 1000;

/** `"07:30"` -> `"30 7 * * *"` (every day at that wall-clock time). */
export function dailyCron(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${m} ${h} * * *`;
}

type SchedulerConfig = Pick<Config, "timezone" | "briefingTime" | "quietEnd">;

/** Turns the clock into queued jobs; the worker does the actual work. Deduplicated, so firing twice is harmless. */
export class Scheduler {
  private timers: Cron[] = [];

  constructor(
    private readonly queue: JobQueue,
    private readonly cfg: SchedulerConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  enqueueBriefing(): void {
    this.queue.enqueue("briefing", {}, { dedupeKey: `briefing:${this.today()}` });
  }

  enqueueFlushDeferred(): void {
    this.queue.enqueue("flush-deferred", {}, { dedupeKey: `flush-deferred:${this.today()}` });
  }

  enqueueHeartbeat(): void {
    const slot = Math.floor(this.clock().getTime() / HEARTBEAT_MS);
    this.queue.enqueue("heartbeat", {}, { dedupeKey: `heartbeat:${slot}` });
  }

  start(): void {
    if (this.timers.length > 0) return;
    const options = { timezone: this.cfg.timezone };
    const guarded = (fn: () => void) => () => {
      try {
        fn();
      } catch (err) {
        console.error("[scheduler] failed to queue a job:", err instanceof Error ? err.message : err);
      }
    };
    this.timers = [
      new Cron("*/30 * * * *", options, guarded(() => this.enqueueHeartbeat())),
      new Cron(dailyCron(this.cfg.briefingTime), options, guarded(() => this.enqueueBriefing())),
      new Cron(dailyCron(this.cfg.quietEnd), options, guarded(() => this.enqueueFlushDeferred())),
    ];
  }

  stop(): void {
    for (const t of this.timers) t.stop();
    this.timers = [];
  }

  private today(): string {
    return localDateKey(this.clock(), this.cfg.timezone);
  }
}
