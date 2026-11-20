import { GoogleAuthError } from "./google/auth.js";
import type { CalendarClient } from "./google/calendar.js";
import type { ConnectorState, GmailClient, MailItem, SeenItems } from "./google/gmail.js";
import type { Notifier } from "./notify/notifier.js";
import { localDateKey } from "./time.js";
import { ruleTriage, ruleTriageEvent, type Verdict } from "./triage/rules.js";

const EVENT_LOOKAHEAD_MS = 3 * 3_600_000;
const HISTORY_KEY = "gmail.historyId";

export interface PollDeps {
  gmail: Pick<GmailClient, "currentHistoryId" | "newMessagesSince">;
  calendar: Pick<CalendarClient, "listBetween">;
  seen: SeenItems;
  state: ConnectorState;
  notifier: Pick<Notifier, "notify">;
  /** Model triage for mail the rules could not decide. */
  triage: (items: MailItem[]) => Promise<Map<string, Verdict>>;
  vip: string[];
  tz: string;
  clock: () => Date;
}

/** Checks Gmail and Calendar for anything new and hands each item to the notifier once. */
export class PollService {
  constructor(private readonly d: PollDeps) {}

  async pollOnce(): Promise<{ mail: number; events: number }> {
    try {
      const mail = await this.pollMail();
      const events = await this.pollCalendar();
      return { mail, events };
    } catch (err) {
      if (err instanceof GoogleAuthError) {
        // One message per day, and the job still completes: retrying cannot fix a revoked sign-in.
        await this.d.notifier.notify({
          dedupeKey: `google-auth:${localDateKey(this.d.clock(), this.d.tz)}`,
          priority: "urgent",
          text: "Google needs to be connected again. On the Mac, run: npm run google-auth",
        });
        return { mail: 0, events: 0 };
      }
      throw err;
    }
  }

  private async pollMail(): Promise<number> {
    const last = this.d.state.get(HISTORY_KEY);
    if (last === null) {
      // First run: start from now. Old mail is never read or announced.
      this.d.state.set(HISTORY_KEY, await this.d.gmail.currentHistoryId());
      return 0;
    }
    const { items, historyId } = await this.d.gmail.newMessagesSince(last);
    const fresh = items.filter((i) => !this.d.seen.has("gmail", i.id));

    const verdicts = new Map<string, Verdict>();
    const undecided: MailItem[] = [];
    for (const item of fresh) {
      const v = ruleTriage(item, { vip: this.d.vip });
      if (v) verdicts.set(item.id, v);
      else undecided.push(item);
    }
    if (undecided.length > 0) for (const [id, v] of await this.d.triage(undecided)) verdicts.set(id, v);

    for (const item of fresh) {
      const v = verdicts.get(item.id) ?? { priority: "normal" as const, summary: item.subject, decidedBy: "rule" as const };
      await this.d.notifier.notify({
        dedupeKey: `gmail:${item.id}`,
        priority: v.priority,
        text: `Email from ${item.from}: ${v.summary}`,
      });
      // Marked only after delivery succeeded, so a failure part-way loses nothing.
      this.d.seen.markIfNew("gmail", item.id);
    }
    this.d.state.set(HISTORY_KEY, historyId);
    return fresh.length;
  }

  private async pollCalendar(): Promise<number> {
    const now = this.d.clock();
    const events = await this.d.calendar.listBetween(now, new Date(now.getTime() + EVENT_LOOKAHEAD_MS));
    let count = 0;
    for (const e of events) {
      const stateKey = `cal:${e.id}`;
      const signature = `${e.start.toISOString()}|${e.location ?? ""}`;
      const previous = this.d.state.get(stateKey);
      if (previous !== null && JSON.parse(previous).signature === signature) continue;
      const prev = previous !== null ? { ...e, start: new Date(JSON.parse(previous).start as string) } : undefined;
      const v = ruleTriageEvent(e, now, prev);
      if (!v) continue;
      await this.d.notifier.notify({
        dedupeKey: `cal:${e.id}:${e.start.toISOString()}:${e.location ?? ""}`,
        priority: v.priority,
        text: v.summary,
      });
      this.d.state.set(stateKey, JSON.stringify({ signature, start: e.start.toISOString() }));
      count++;
    }
    return count;
  }
}
