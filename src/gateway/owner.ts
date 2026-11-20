import { randomBytes } from "node:crypto";
import type { Db } from "../db.js";

const CODE_TTL_MS = 15 * 60 * 1000;

/** Who the owner is on each channel, set up with a one-time pairing code. */
export class OwnerRegistry {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A single-use code, valid for 15 minutes. Show it only to the person at the console. */
  createPairingCode(): string {
    const now = this.clock();
    this.db.prepare("DELETE FROM pairing WHERE created_at < ?").run(now - CODE_TTL_MS);
    const code = randomBytes(6).toString("hex");
    this.db.prepare("INSERT INTO pairing(code, created_at, used) VALUES (?, ?, 0)").run(code, now);
    return code;
  }

  /** Make this person the owner on `channel` if the code is valid; returns whether it worked. */
  pair(channel: string, channelUserId: string, chatId: string, code: string): boolean {
    const normalized = code.trim().toLowerCase();
    return this.db.transaction((): boolean => {
      const row = this.db.prepare("SELECT created_at, used FROM pairing WHERE code = ?").get(normalized) as
        | { created_at: number; used: number }
        | undefined;
      if (!row || row.used !== 0 || this.clock() - row.created_at > CODE_TTL_MS) return false;
      this.db.prepare("UPDATE pairing SET used = 1 WHERE code = ?").run(normalized);
      this.setOwner(channel, channelUserId, chatId);
      return true;
    })();
  }

  /** Set the owner directly, replacing any earlier owner on the channel (used by dev mode and pairing). */
  setOwner(channel: string, channelUserId: string, chatId: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM owner_identities WHERE channel = ?").run(channel);
      this.db
        .prepare("INSERT INTO owner_identities(channel, channel_user_id, chat_id, paired_at) VALUES (?, ?, ?, ?)")
        .run(channel, channelUserId, chatId, this.clock());
    })();
  }

  isOwner(channel: string, channelUserId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM owner_identities WHERE channel = ? AND channel_user_id = ?")
        .get(channel, channelUserId) !== undefined
    );
  }

  hasOwner(channel: string): boolean {
    return this.ownerChat(channel) !== null;
  }

  ownerChat(channel: string): string | null {
    const row = this.db.prepare("SELECT chat_id FROM owner_identities WHERE channel = ?").get(channel) as
      | { chat_id: string }
      | undefined;
    return row?.chat_id ?? null;
  }
}
