import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import type { GoogleHttp } from "../src/google/auth.js";
import { CalendarClient } from "../src/google/calendar.js";
import { TasksClient } from "../src/google/tasks.js";
import { AmbiguousActionError } from "../src/idempotency.js";

type Opts = { query?: Record<string, string>; body?: any };
function fakeHttp(route: (method: string, url: string, opts?: Opts) => unknown) {
  const json = vi.fn(async (method: string, url: string, opts?: Opts) => route(method, url, opts));
  return { http: { json } as unknown as Pick<GoogleHttp, "json">, json };
}

describe("CalendarClient", () => {
  it("lists events between two instants and maps timed and all-day events", async () => {
    const { http, json } = fakeHttp(() => ({
      items: [
        {
          id: "e1",
          summary: "Standup",
          start: { dateTime: "2026-11-20T14:00:00-05:00" },
          end: { dateTime: "2026-11-20T14:30:00-05:00" },
          location: "Room 4",
          updated: "2026-11-19T10:00:00.000Z",
        },
        { id: "e2", summary: "Holiday", start: { date: "2026-11-26" }, end: { date: "2026-11-27" }, updated: "2026-11-01T00:00:00.000Z" },
        { id: "e3", start: { dateTime: "2026-11-20T20:00:00Z" }, end: { dateTime: "2026-11-20T21:00:00Z" }, updated: "2026-11-01T00:00:00.000Z" },
      ],
    }));
    const cal = new CalendarClient(http, openDb(":memory:"));
    const from = new Date("2026-11-20T05:00:00Z");
    const to = new Date("2026-11-21T05:00:00Z");
    const events = await cal.listBetween(from, to);
    const [, url, opts] = json.mock.calls[0]!;
    expect(url).toContain("/calendars/primary/events");
    expect(opts!.query).toMatchObject({
      timeMin: "2026-11-20T05:00:00.000Z",
      timeMax: "2026-11-21T05:00:00.000Z",
      singleEvents: "true",
      orderBy: "startTime",
    });
    expect(events[0]).toEqual({
      id: "e1",
      title: "Standup",
      start: new Date("2026-11-20T19:00:00Z"),
      end: new Date("2026-11-20T19:30:00Z"),
      allDay: false,
      location: "Room 4",
      updated: new Date("2026-11-19T10:00:00.000Z"),
    });
    expect(events[1]!.allDay).toBe(true);
    expect(events[2]!.title).toBe("(no title)");
  });

  const draft = { title: "Dentist", start: new Date("2026-11-25T15:00:00Z"), end: new Date("2026-11-25T16:00:00Z") };
  const created = {
    id: "new1",
    summary: "Dentist",
    start: { dateTime: "2026-11-25T15:00:00.000Z" },
    end: { dateTime: "2026-11-25T16:00:00.000Z" },
    updated: "2026-11-20T10:00:00.000Z",
  };

  it("creates an event once even if asked twice with the same details", async () => {
    const { http, json } = fakeHttp(() => created);
    const cal = new CalendarClient(http, openDb(":memory:"));
    const a = await cal.createEvent(draft);
    const b = await cal.createEvent(draft);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0]![2]!.body).toMatchObject({
      summary: "Dentist",
      start: { dateTime: "2026-11-25T15:00:00.000Z" },
      end: { dateTime: "2026-11-25T16:00:00.000Z" },
    });
    expect(a.id).toBe("new1");
    expect(b.id).toBe("new1");
    expect(b.start).toEqual(draft.start);
  });

  it("refuses to repeat an event whose earlier attempt never finished", async () => {
    const db = openDb(":memory:");
    const { http, json } = fakeHttp(() => created);
    const cal = new CalendarClient(http, db);
    await cal.createEvent(draft);
    // Simulate a crash after the call but before it was recorded as finished.
    db.prepare("UPDATE idempotency SET status = 'started', result = NULL WHERE key LIKE 'event:%'").run();
    await expect(cal.createEvent(draft)).rejects.toBeInstanceOf(AmbiguousActionError);
    expect(json).toHaveBeenCalledTimes(1);
  });
});

describe("TasksClient", () => {
  it("lists only open tasks", async () => {
    const { http, json } = fakeHttp(() => ({
      items: [
        { id: "t1", title: "Pay rent", status: "needsAction", due: "2026-11-30T00:00:00.000Z" },
        { id: "t2", title: "Done thing", status: "completed" },
        { id: "t3", title: "No due", status: "needsAction" },
      ],
    }));
    const tasks = await new TasksClient(http, openDb(":memory:")).listOpen();
    expect(json.mock.calls[0]![1]).toContain("/lists/@default/tasks");
    expect(tasks).toEqual([
      { id: "t1", title: "Pay rent", due: new Date("2026-11-30T00:00:00.000Z"), done: false },
      { id: "t3", title: "No due", due: undefined, done: false },
    ]);
  });

  it("creates a task once for identical requests", async () => {
    const { http, json } = fakeHttp(() => ({ id: "t9", title: "Call mom", status: "needsAction" }));
    const tasks = new TasksClient(http, openDb(":memory:"));
    const a = await tasks.create("Call mom");
    const b = await tasks.create("Call mom");
    expect(json).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ id: "t9", title: "Call mom", due: undefined, done: false });
    expect(b).toEqual(a);
  });

  it("sends the due date when given", async () => {
    const { http, json } = fakeHttp(() => ({ id: "t9", title: "Report", status: "needsAction", due: "2026-12-01T00:00:00.000Z" }));
    const t = await new TasksClient(http, openDb(":memory:")).create("Report", new Date("2026-12-01T00:00:00Z"));
    expect(json.mock.calls[0]![2]!.body).toEqual({ title: "Report", due: "2026-12-01T00:00:00.000Z" });
    expect(t.due).toEqual(new Date("2026-12-01T00:00:00Z"));
  });
});
