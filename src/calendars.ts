import type { CalEvent, CalendarClient } from "./google/calendar.js";

export type CalendarPort = Pick<CalendarClient, "listBetween" | "createEvent">;

interface ExtraCalendar {
  name: string;
  listBetween(from: Date, to: Date): Promise<CalEvent[]>;
}

// Every instance of a recurring series shares one uid, so the start time is part of the key.
const keyOf = (e: CalEvent): string =>
  e.uid ? `uid:${e.uid}|${e.start.toISOString()}` : `t:${e.title.trim().toLowerCase()}|${e.start.toISOString()}`;

/**
 * One calendar made of the primary plus extra read-only sources. The same event seen twice
 * (by uid, else by title and start) appears once, the primary's copy winning. An extra that
 * fails is reported and skipped, so it can never take the primary down. New events go to the primary only.
 */
export function mergeCalendars(
  primary: CalendarPort,
  extras: ExtraCalendar[],
  onError: (name: string, err: unknown) => void,
): CalendarPort {
  return {
    createEvent: (e) => primary.createEvent(e),
    async listBetween(from, to) {
      const lists = [await primary.listBetween(from, to)];
      for (const extra of extras) {
        try {
          lists.push(await extra.listBetween(from, to));
        } catch (err) {
          onError(extra.name, err);
        }
      }
      const seen = new Set<string>();
      const out: CalEvent[] = [];
      for (const list of lists) {
        for (const e of list) {
          const k = keyOf(e);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(e);
        }
      }
      return out.sort((a, b) => a.start.getTime() - b.start.getTime());
    },
  };
}
