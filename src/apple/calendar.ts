import { z } from "zod";
import type { CalEvent } from "../google/calendar.js";
import type { ScriptRunner } from "./osascript.js";

const MAX_EVENTS = 100;

// Calendar.app scripting lists only the first occurrence of an Apple-native recurring event.
const SCRIPT = `
function run(argv) {
  var range = JSON.parse(argv[0]);
  var from = new Date(range.from), to = new Date(range.to);
  var app = Application("Calendar");
  var out = [];
  var cals = app.calendars();
  for (var i = 0; i < cals.length; i++) {
    var evs = cals[i].events.whose({_and: [{startDate: {_lessThan: to}}, {endDate: {_greaterThan: from}}]})();
    for (var j = 0; j < evs.length; j++) {
      var e = evs[j];
      out.push({
        uid: String(e.uid()),
        title: e.summary() || "",
        start: e.startDate().toISOString(),
        end: e.endDate().toISOString(),
        allDay: !!e.alldayEvent(),
        location: e.location() || undefined
      });
    }
  }
  return JSON.stringify(out);
}`;

const entry = z.object({
  uid: z.string().min(1),
  title: z.string(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  allDay: z.boolean().default(false),
  location: z.string().optional(),
});

export class AppleCalendarClient {
  constructor(private readonly run: ScriptRunner) {}

  async listBetween(from: Date, to: Date): Promise<CalEvent[]> {
    const raw: unknown = JSON.parse(await this.run(SCRIPT, { from: from.toISOString(), to: to.toISOString() }));
    if (!Array.isArray(raw)) throw new Error("Apple Calendar returned something unexpected");
    const events: CalEvent[] = [];
    for (const item of raw) {
      const parsed = entry.safeParse(item);
      if (!parsed.success) continue;
      const e = parsed.data;
      events.push({
        id: `apple:${e.uid}`,
        uid: e.uid,
        title: e.title.trim() || "(no title)",
        start: new Date(e.start),
        end: new Date(e.end),
        allDay: e.allDay,
        location: e.location || undefined,
        updated: new Date(0),
      });
      if (events.length >= MAX_EVENTS) break;
    }
    return events;
  }
}
