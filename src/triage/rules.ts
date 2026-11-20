import type { CalEvent } from "../google/calendar.js";
import type { MailItem } from "../google/gmail.js";

export interface Verdict {
  priority: "urgent" | "normal" | "low";
  summary: string;
  decidedBy: "rule" | "model";
}

const URGENT_WINDOW_MS = 3 * 3_600_000;

/** The bare address from `Name <a@b.c>` or `a@b.c`, lowercased. */
export function addressOf(from: string): string {
  const inBrackets = from.match(/<([^>]+)>/);
  return (inBrackets ? inBrackets[1]! : from).trim().toLowerCase();
}

/** Decide without any model when the answer is obvious; `null` means a model should look. */
export function ruleTriage(item: MailItem, ctx: { vip: string[] }): Verdict | null {
  if (ctx.vip.includes(addressOf(item.from))) {
    return { priority: "urgent", summary: `${item.subject} (from ${item.from})`, decidedBy: "rule" };
  }
  if (item.isBulk) return { priority: "low", summary: item.subject, decidedBy: "rule" };
  return null;
}

function until(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** An event that starts within 3 hours is worth interrupting for. `prev` is the version seen last time. */
export function ruleTriageEvent(e: CalEvent, now: Date, prev?: CalEvent): Verdict | null {
  if (e.allDay) return null;
  const delta = e.start.getTime() - now.getTime();
  if (delta < 0 || delta > URGENT_WINDOW_MS) return null;
  const moved = prev !== undefined && prev.start.getTime() !== e.start.getTime();
  const summary = moved ? `${e.title} moved: now starts in ${until(delta)}` : `${e.title} starts in ${until(delta)}`;
  return { priority: "urgent", summary, decidedBy: "rule" };
}
