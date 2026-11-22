import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { GmailClient } from "../google/gmail.js";

const TTL_MS = 24 * 3_600_000;
/** The most emails one approval can cover; a bigger clean-up is done in several approved rounds. */
export const MAX_TRASH_BATCH = 200;
const EXAMPLES = 5;

export type TrashDecision = "trashed" | "rejected" | "expired" | "already-decided" | "unknown-id";

interface Row {
  id: string;
  query: string;
  ids_json: string;
  count: number;
  status: string;
  expires_at: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The only code that can move mail to Trash. The owner approves an exact, frozen list of emails:
 * what is moved is that list, never a fresh search. Nothing is deleted for good, and approvals lapse after 24 hours.
 */
export class TrashGate {
  constructor(
    private readonly db: Db,
    private readonly gmail: Pick<GmailClient, "listIds" | "trash" | "summaries">,
    private readonly ask: (text: string, approvalId: string) => Promise<void>,
    private readonly clock: () => Date,
  ) {}

  /** Freeze the emails matching `query` and ask the owner. Returns null when nothing matches. */
  async request(query: string): Promise<{ id: string; count: number } | null> {
    const { ids, more } = await this.gmail.listIds(query, MAX_TRASH_BATCH);
    if (ids.length === 0) return null;
    const examples = await this.gmail.summaries(ids.slice(0, EXAMPLES));
    const id = randomBytes(6).toString("hex");
    const now = this.clock().getTime();
    this.db
      .prepare(
        "INSERT INTO trash_requests (id, query, ids_json, count, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(id, query, JSON.stringify(ids), ids.length, now, now + TTL_MS);
    const lines = examples.map((e) => `- ${clean(e.from)}: ${clean(e.subject)} (${day(e.date)})`);
    const limit = more ? `\nMore matched, but this covers only the first ${MAX_TRASH_BATCH}.` : "";
    await this.ask(
      `Move ${ids.length} emails to Trash?\nSearch: ${query}\n\nExamples:\n${lines.join("\n")}${limit}\n\nThey stay in Gmail's Trash for 30 days, so you can restore them. This request expires in 24 hours.`,
      id,
    );
    return { id, count: ids.length };
  }

  /** Requests still waiting for the owner, oldest first. */
  pending(): { id: string; summary: string }[] {
    const rows = this.db
      .prepare("SELECT id, query, count FROM trash_requests WHERE status = 'pending' AND expires_at > ? ORDER BY created_at")
      .all(this.clock().getTime()) as { id: string; query: string; count: number }[];
    return rows.map((r) => ({ id: r.id, summary: `Move ${r.count} emails to Trash (search: ${clean(r.query)})` }));
  }

  /**
   * `next` is set only after a full batch was trashed: it is the follow-up request for what is left
   * (null when nothing is left or the question could not be sent). The next batch needs its own approval.
   */
  async decide(
    id: string,
    verdict: "approve" | "reject",
  ): Promise<{ decision: TrashDecision; count: number; next?: { id: string; count: number } | null }> {
    const row = this.db.prepare("SELECT id, query, ids_json, count, status, expires_at FROM trash_requests WHERE id = ?").get(id) as Row | undefined;
    if (!row) return { decision: "unknown-id", count: 0 };
    if (row.status !== "pending") return { decision: "already-decided", count: row.count };
    const now = this.clock().getTime();
    if (now > row.expires_at) {
      this.setStatus(id, "expired", now);
      return { decision: "expired", count: row.count };
    }
    if (verdict === "reject") {
      this.setStatus(id, "rejected", now);
      return { decision: "rejected", count: row.count };
    }

    // Claim it so two taps can never both proceed.
    const claimed = this.db.prepare("UPDATE trash_requests SET status = 'running' WHERE id = ? AND status = 'pending'").run(id);
    if (claimed.changes === 0) return { decision: "already-decided", count: row.count };
    try {
      await this.gmail.trash(JSON.parse(row.ids_json) as string[]);
    } catch (err) {
      // Moving to Trash twice is harmless, so after a failure the owner may simply tap again.
      this.db.prepare("UPDATE trash_requests SET status = 'pending' WHERE id = ? AND status = 'running'").run(id);
      throw err;
    }
    this.setStatus(id, "trashed", now);
    if (row.count < MAX_TRASH_BATCH) return { decision: "trashed", count: row.count };
    // A full batch means there may be more. The emails are already moved, so a failure here must not hide that.
    const next = await this.request(row.query).catch(() => null);
    return { decision: "trashed", count: row.count, next };
  }

  private setStatus(id: string, status: string, at: number): void {
    this.db.prepare("UPDATE trash_requests SET status = ?, decided_at = ? WHERE id = ?").run(status, at, id);
  }
}
