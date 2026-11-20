import { Cron } from "croner";
import type { Config } from "./config.js";
import type { JobQueue } from "./queue/queue.js";
import { localDateKey } from "./time.js";

const HEARTBEAT_MS = 30 * 60 * 1000;
const POLL_MS = 10 * 60 * 1000;

/** Sundays at 03:00 local time, inside quiet hours. */
export const CONSOLIDATE_CRON = "0 3 * * 0";

/** `"07:30"` -> `"30 7 * * *"` (every day at that wall-clock time). */
export function dailyCron(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${m} ${h} * * *`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
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

  enqueuePoll(): void {
    const slot = Math.floor(this.clock().getTime() / POLL_MS);
    this.queue.enqueue("poll", {}, { dedupeKey: `poll:${slot}` });
  }

  enqueueConsolidate(): void {
    this.queue.enqueue("consolidate", {}, { dedupeKey: `consolidate:${this.today()}` });
  }

  enqueueHeartbeat(): void {
    const slot = Math.floor(this.clock().getTime() / HEARTBEAT_MS);
    this.queue.enqueue("heartbeat", {}, { dedupeKey: `heartbeat:${slot}` });
  }

  /** Queue today's briefing / overnight flush if their time already passed (Mac asleep or restarting). Deduplicated per day. */
  catchUp(): void {
    const minutes = this.localMinutes();
    if (minutes >= toMinutes(this.cfg.quietEnd)) this.enqueueFlushDeferred();
    if (minutes >= toMinutes(this.cfg.briefingTime)) this.enqueueBriefing();
  }

  start(): void {
    if (this.timers.length > 0) return;
    this.catchUp();
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
      new Cron("*/10 * * * *", options, guarded(() => this.enqueuePoll())),
      new Cron(dailyCron(this.cfg.briefingTime), options, guarded(() => this.enqueueBriefing())),
      new Cron(dailyCron(this.cfg.quietEnd), options, guarded(() => this.enqueueFlushDeferred())),
      new Cron(CONSOLIDATE_CRON, options, guarded(() => this.enqueueConsolidate())),
    ];
  }

  stop(): void {
    for (const t of this.timers) t.stop();
    this.timers = [];
  }

  private localMinutes(): number {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: this.cfg.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(this.clock());
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return get("hour") * 60 + get("minute");
  }

  private today(): string {
    return localDateKey(this.clock(), this.cfg.timezone);
  }
}
