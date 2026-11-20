import { BudgetExhaustedError } from "../budget/guard.js";
import type { Db } from "../db.js";
import type { OwnerRegistry } from "./owner.js";
import type { ChannelAdapter, InboundMessage } from "./types.js";

const TELEGRAM_LIMIT = 4096;

/** Split `text` into pieces of at most `limit` characters, preferring to break at a line end. */
export function chunkMessage(text: string, limit = TELEGRAM_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at === cut ? at + 1 : at);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export interface GatewayDeps {
  owners: OwnerRegistry;
  adapters: ChannelAdapter[];
  /** Produce the reply for one owner message in a session. */
  respond: (sessionId: string, userText: string) => Promise<string>;
  db: Db;
}

/**
 * The single entry point for every channel. Only the paired owner, in a private chat, is ever
 * answered; everyone else is ignored without a reply.
 */
export class Gateway {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: GatewayDeps) {}

  async start(): Promise<void> {
    for (const adapter of this.deps.adapters) {
      await adapter.start((m) => this.handle(m, adapter));
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.deps.adapters) await adapter.stop();
  }

  async handle(msg: InboundMessage, adapter: ChannelAdapter): Promise<void> {
    const text = msg.text?.trim() || null;

    if (msg.isPrivate && text && /^\/pair(\s|$)/i.test(text)) {
      const code = text.slice("/pair".length).trim();
      if (this.deps.owners.pair(msg.channel, msg.channelUserId, msg.chatId, code)) {
        await this.safeSend(adapter, msg.chatId, "Paired.");
      }
      return;
    }

    if (!msg.isPrivate || !this.deps.owners.isOwner(msg.channel, msg.channelUserId)) return;

    if (text === null) {
      await this.safeSend(adapter, msg.chatId, "I can only read text for now.");
      return;
    }

    const sessionId = this.sessionFor(msg);
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const run = previous.then(() => this.answer(adapter, msg.chatId, sessionId, text));
    this.chains.set(sessionId, run);
    try {
      await run;
    } finally {
      if (this.chains.get(sessionId) === run) this.chains.delete(sessionId);
    }
  }

  private sessionFor(msg: InboundMessage): string {
    const id = `${msg.channel}:${msg.chatId}`;
    this.deps.db
      .prepare("INSERT OR IGNORE INTO sessions(id, channel, chat_id, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, msg.channel, msg.chatId, Date.now());
    return id;
  }

  private async answer(adapter: ChannelAdapter, chatId: string, sessionId: string, text: string): Promise<void> {
    let reply: string;
    try {
      reply = await this.deps.respond(sessionId, text);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        reply = "Budget reached for today; I'll resume at midnight.";
      } else {
        // Log the kind of failure only: error messages can echo private content.
        console.error("[gateway] respond failed:", err instanceof Error ? err.name : "unknown error");
        reply = "Something went wrong on my side. Please try again.";
      }
    }
    if (reply.trim() === "") return;
    for (const part of chunkMessage(reply)) await this.safeSend(adapter, chatId, part);
  }

  private async safeSend(adapter: ChannelAdapter, chatId: string, text: string): Promise<void> {
    try {
      await adapter.send(chatId, text);
    } catch (err) {
      console.error("[gateway] send failed on", adapter.name, err instanceof Error ? err.name : "unknown error");
    }
  }
}
