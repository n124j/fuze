import type { Db } from "../db.js";
import { isQuietHours } from "../time.js";

export type Priority = "urgent" | "normal" | "low";

export interface Notification {
  /** Identifies the underlying item (for example an email id); the same key is never notified twice. */
  dedupeKey: string;
  priority: Priority;
  text: string;
}

export type NotifyOutcome = "sent" | "deferred" | "duplicate" | "digest";

export interface QuietConfig {
  timezone: string;
  quietStart: string;
  quietEnd: string;
}

/**
 * Decides when the owner gets interrupted: urgent always, normal outside quiet hours (otherwise held
 * for the morning), low only inside the next briefing. An item is never delivered twice.
 */
export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly send: (text: string) => Promise<void>,
    private readonly cfg: QuietConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async notify(n: Notification): Promise<NotifyOutcome> {
    const now = this.clock();
    const isQuiet = isQuietHours(now, this.cfg.timezone, this.cfg.quietStart, this.cfg.quietEnd);

    const hold = n.priority === "low" ? "digest" : n.priority === "normal" && isQuiet ? "deferred" : null;
    const claimed = this.db
      .prepare(
        "INSERT OR IGNORE INTO notifications(dedupe_key, priority, text, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(n.dedupeKey, n.priority, n.text, hold ?? "sending", now.getTime());
    if (claimed.changes === 0) return "duplicate";
    if (hold) return hold;

    try {
      await this.send(n.text);
    } catch (err) {
      // Delivery failed: forget the claim so the same item can be tried again.
      this.db.prepare("DELETE FROM notifications WHERE dedupe_key = ?").run(n.dedupeKey);
      throw err;
    }
    this.db
      .prepare("UPDATE notifications SET status = 'sent', sent_at = ? WHERE dedupe_key = ?")
      .run(this.clock().getTime(), n.dedupeKey);
    return "sent";
  }

  /** Send everything held during quiet hours as one message. Does nothing while it is still quiet. */
  async flushDeferred(): Promise<number> {
    const now = this.clock();
    if (isQuietHours(now, this.cfg.timezone, this.cfg.quietStart, this.cfg.quietEnd)) return 0;
    const rows = this.db
      .prepare("SELECT id, text FROM notifications WHERE status = 'deferred' ORDER BY id")
      .all() as { id: number; text: string }[];
    if (rows.length === 0) return 0;

    await this.send(["While you were away:", ...rows.map((r) => `• ${r.text}`)].join("\n"));

    const mark = this.db.prepare("UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const r of rows) mark.run(now.getTime(), r.id);
    })();
    return rows.length;
  }

  /** Low-priority items waiting for the briefing; returns them once and clears them. */
  takeDigest(): string[] {
    return this.db.transaction((): string[] => {
      const rows = this.db
        .prepare("SELECT id, text FROM notifications WHERE status = 'digest' ORDER BY id")
        .all() as { id: number; text: string }[];
      const mark = this.db.prepare("UPDATE notifications SET status = 'digested' WHERE id = ?");
      for (const r of rows) mark.run(r.id);
      return rows.map((r) => r.text);
    })();
  }
}
