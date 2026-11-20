import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import { runOnce } from "../idempotency.js";
import type { GoogleHttp } from "./auth.js";

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export interface CalEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  updated: Date;
  /** iCalendar UID, shared between calendar apps, used to spot the same event twice. */
  uid?: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  updated?: string;
  iCalUID?: string;
}

const when = (t: { dateTime?: string; date?: string }): Date => new Date(t.dateTime ?? `${t.date}T00:00:00Z`);

function toEvent(g: GoogleEvent): CalEvent {
  return {
    id: g.id,
    title: g.summary?.trim() || "(no title)",
    start: when(g.start),
    end: when(g.end),
    allDay: !g.start.dateTime,
    location: g.location,
    updated: new Date(g.updated ?? 0),
    uid: g.iCalUID,
  };
}

export class CalendarClient {
  constructor(
    private readonly http: Pick<GoogleHttp, "json">,
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  async listBetween(from: Date, to: Date): Promise<CalEvent[]> {
    const res = await this.http.json<{ items?: GoogleEvent[] }>("GET", EVENTS, {
      query: {
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "50",
      },
    });
    return (res.items ?? []).map(toEvent);
  }

  /** Creates the event on the primary calendar. The same title and times are never created twice. */
  async createEvent(e: { title: string; start: Date; end: Date; location?: string }): Promise<CalEvent> {
    // Scoped to the current hour: a retry of the same request collapses, a genuine repeat later does not.
    const hour = Math.floor(this.now() / 3_600_000);
    const key = `event:${createHash("sha256").update(`${hour}|${e.title}|${e.start.toISOString()}|${e.end.toISOString()}`).digest("hex")}`;
    // runOnce stores JSON, so keep the raw Google shape and convert on the way out.
    const raw = await runOnce(this.db, key, () =>
      this.http.json<GoogleEvent>("POST", EVENTS, {
        body: {
          summary: e.title,
          start: { dateTime: e.start.toISOString() },
          end: { dateTime: e.end.toISOString() },
          ...(e.location ? { location: e.location } : {}),
        },
      }),
    );
    return toEvent(raw);
  }
}
