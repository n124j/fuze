import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db.js";
import type { DraftContent, GmailClient } from "../google/gmail.js";
import { AmbiguousActionError, runOnce } from "../idempotency.js";

const APPROVAL_TTL_MS = 24 * 3_600_000;

export type Decision =
  | "sent"
  | "rejected"
  | "expired"
  | "changed"
  | "already-decided"
  | "unknown-id"
  | "send-unconfirmed";

const norm = (list: string[]) => list.map((a) => a.trim().toLowerCase()).sort();

/** Fingerprint of exactly what the owner approves: who it goes to, the subject and the body. */
export function draftHash(d: DraftContent): string {
  return createHash("sha256")
    .update(JSON.stringify([norm(d.to), norm(d.cc), d.subject, d.body]))
    .digest("hex");
}

interface Row {
  id: string;
  draft_id: string;
  hash: string;
  status: string;
  expires_at: number;
}

/**
 * The only code that can send an email. The owner approves a frozen draft; if the draft
 * differs at send time, or 24 hours pass, the approval is void.
 */
export class ApprovalGate {
  constructor(
    private readonly db: Db,
    private readonly gmail: Pick<GmailClient, "getDraft" | "sendDraft">,
    private readonly ask: (text: string, approvalId: string) => Promise<void>,
    private readonly clock: () => Date,
  ) {}

  async request(draftId: string): Promise<string> {
    const draft = await this.gmail.getDraft(draftId);
    const id = randomBytes(6).toString("hex");
    const now = this.clock().getTime();
    const recipients = [...draft.to, ...draft.cc.map((c) => `${c} (cc)`)].join(", ");
    const summary = `To: ${recipients} | Subject: ${draft.subject}`;
    this.db
      .prepare(
        "INSERT INTO approvals (id, draft_id, summary, hash, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(id, draftId, summary, draftHash(draft), now, now + APPROVAL_TTL_MS);
    await this.ask(
      `Approve sending this email?\nTo: ${recipients}\nSubject: ${draft.subject}\nThe full text is in your Gmail drafts. It expires in 24 hours.`,
      id,
    );
    return id;
  }

  pending(): { id: string; summary: string }[] {
    return this.db
      .prepare("SELECT id, summary FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at")
      .all(this.clock().getTime()) as { id: string; summary: string }[];
  }

  async decide(id: string, verdict: "approve" | "reject"): Promise<Decision> {
    const row = this.db.prepare("SELECT id, draft_id, hash, status, expires_at FROM approvals WHERE id = ?").get(id) as Row | undefined;
    if (!row) return "unknown-id";
    if (row.status === "sending") return "send-unconfirmed";
    if (row.status !== "pending") return "already-decided";
    const now = this.clock().getTime();
    if (now > row.expires_at) {
      this.setStatus(id, "expired", now);
      return "expired";
    }
    if (verdict === "reject") {
      this.setStatus(id, "rejected", now);
      return "rejected";
    }

    const current = await this.gmail.getDraft(row.draft_id);
    if (draftHash(current) !== row.hash) {
      this.setStatus(id, "void", now);
      return "changed";
    }

    // Claim the send so two taps can never both proceed.
    const claimed = this.db.prepare("UPDATE approvals SET status = 'sending' WHERE id = ? AND status = 'pending'").run(id);
    if (claimed.changes === 0) return "already-decided";
    try {
      await runOnce(this.db, `send:${id}`, () => this.gmail.sendDraft(row.draft_id));
    } catch (err) {
      if (err instanceof AmbiguousActionError) {
        this.setStatus(id, "unconfirmed", now);
        return "send-unconfirmed";
      }
      this.db.prepare("UPDATE approvals SET status = 'pending' WHERE id = ? AND status = 'sending'").run(id);
      throw err;
    }
    this.setStatus(id, "sent", now);
    return "sent";
  }

  private setStatus(id: string, status: string, at: number): void {
    this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(status, at, id);
  }
}
