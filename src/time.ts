const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallClock(date: Date, tz: string): Wall {
  const out: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year!, mo: out.month!, d: out.day!, h: out.hour!, mi: out.minute!, s: out.second! };
}

function parseHhmm(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`bad time "${hhmm}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Offset of `tz` from UTC at the instant `utcMs`, in ms (negative west of UTC). */
function offsetMs(utcMs: number, tz: string): number {
  const floored = Math.floor(utcMs / 1000) * 1000;
  const w = wallClock(new Date(floored), tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - floored;
}

/** The instant at which the wall clock in `tz` reads the given date and time. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = offsetMs(guess, tz);
  let result = guess - off;
  const off2 = offsetMs(result, tz);
  if (off2 !== off) result = guess - off2;
  return result;
}

/** True when `now` falls inside [start, end) on the wall clock of `tz`; the window may cross midnight. */
export function isQuietHours(now: Date, tz: string, start: string, end: string): boolean {
  const w = wallClock(now, tz);
  const t = w.h * 60 + w.mi;
  const s = parseHhmm(start);
  const e = parseHhmm(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

/** `YYYY-MM-DD` of `now` on the wall clock of `tz`. */
export function localDateKey(now: Date, tz: string): string {
  const w = wallClock(now, tz);
  return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
}

/** The next instant after `now` at which the wall clock in `tz` reads `hhmm`. */
export function nextLocalTime(now: Date, tz: string, hhmm: string): Date {
  const minutes = parseHhmm(hhmm);
  const h = Math.floor(minutes / 60);
  const mi = minutes % 60;
  const w = wallClock(now, tz);
  for (let add = 0; add < 3; add++) {
    const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + add));
    const instant = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz);
    if (instant > now.getTime()) return new Date(instant);
  }
  throw new Error("unreachable: no next local time within 3 days");
}
