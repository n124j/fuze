import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { JobQueue } from "../src/queue/queue.js";
import { Scheduler, dailyCron } from "../src/scheduler.js";

const cfg = { timezone: "America/New_York", briefingTime: "07:30", quietEnd: "07:00" };

let db: Db;
let now: Date;
let scheduler: Scheduler;
beforeEach(() => {
  db = openDb(":memory:");
  now = new Date("2026-11-20T12:40:00Z"); // 07:40 on the 20th in New York
  scheduler = new Scheduler(new JobQueue(db, () => now.getTime()), cfg, () => now);
});

const keys = (type: string) =>
  (db.prepare("SELECT dedupe_key FROM jobs WHERE type = ? ORDER BY created_at, rowid").all(type) as { dedupe_key: string }[]).map(
    (r) => r.dedupe_key,
  );

describe("dailyCron", () => {
  it("turns HH:MM into a daily cron pattern", () => {
    expect(dailyCron("07:30")).toBe("30 7 * * *");
    expect(dailyCron("00:05")).toBe("5 0 * * *");
    expect(dailyCron("23:00")).toBe("0 23 * * *");
  });
});

describe("Scheduler jobs", () => {
  it("queues the briefing once per local day, however often it fires", () => {
    scheduler.enqueueBriefing();
    scheduler.enqueueBriefing();
    expect(keys("briefing")).toEqual(["briefing:2026-11-20"]);
    now = new Date("2026-11-21T12:40:00Z");
    scheduler.enqueueBriefing();
    expect(keys("briefing")).toEqual(["briefing:2026-11-20", "briefing:2026-11-21"]);
  });

  it("uses the local date, not the UTC date, in the key", () => {
    now = new Date("2026-11-21T03:00:00Z"); // 22:00 on the 20th in New York
    scheduler.enqueueBriefing();
    expect(keys("briefing")).toEqual(["briefing:2026-11-20"]);
  });

  it("queues the overnight flush once per local day", () => {
    scheduler.enqueueFlushDeferred();
    scheduler.enqueueFlushDeferred();
    expect(keys("flush-deferred")).toEqual(["flush-deferred:2026-11-20"]);
  });

  it("queues one heartbeat per 30-minute slot", () => {
    scheduler.enqueueHeartbeat();
    scheduler.enqueueHeartbeat();
    expect(keys("heartbeat")).toHaveLength(1);
    now = new Date(now.getTime() + 31 * 60 * 1000);
    scheduler.enqueueHeartbeat();
    expect(keys("heartbeat")).toHaveLength(2);
  });
});

describe("Scheduler polling", () => {
  it("queues one poll per 10-minute slot", () => {
    scheduler.enqueuePoll();
    scheduler.enqueuePoll();
    expect(keys("poll")).toHaveLength(1);
    now = new Date(now.getTime() + 11 * 60 * 1000);
    scheduler.enqueuePoll();
    expect(keys("poll")).toHaveLength(2);
  });
});

describe("Scheduler catch-up", () => {
  it("queues a missed briefing and flush when started after their time", () => {
    scheduler.catchUp(); // 07:40 local: both 07:00 and 07:30 have passed
    expect(keys("briefing")).toEqual(["briefing:2026-11-20"]);
    expect(keys("flush-deferred")).toEqual(["flush-deferred:2026-11-20"]);
    scheduler.catchUp();
    expect(keys("briefing")).toHaveLength(1);
  });

  it("queues nothing before their time today", () => {
    now = new Date("2026-11-20T11:00:00Z"); // 06:00 local
    scheduler.catchUp();
    expect(keys("briefing")).toEqual([]);
    expect(keys("flush-deferred")).toEqual([]);
  });

  it("queues only the flush between quiet end and the briefing", () => {
    now = new Date("2026-11-20T12:10:00Z"); // 07:10 local
    scheduler.catchUp();
    expect(keys("briefing")).toEqual([]);
    expect(keys("flush-deferred")).toEqual(["flush-deferred:2026-11-20"]);
  });
});

describe("Scheduler lifecycle", () => {
  it("starts and stops its timers cleanly", () => {
    scheduler.start();
    scheduler.start(); // starting twice must not double up
    scheduler.stop();
    scheduler.stop();
  });
});
