import { Bot } from "grammy";
import type { ChannelAdapter, InboundMessage } from "../gateway/types.js";

/** The part of a grammY message context this adapter reads. */
export interface TelegramContext {
  message?: {
    text?: string;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number };
  };
}

/** The slice of grammY's Bot this adapter uses, so tests can inject a fake. */
export interface BotLike {
  init(): Promise<unknown>;
  on(event: "message", handler: (ctx: TelegramContext) => Promise<void> | void): unknown;
  /** Long polling: resolves only once the bot is stopped. */
  start(): Promise<void>;
  stop(): Promise<void>;
  api: { sendMessage(chatId: number | string, text: string): Promise<unknown> };
}

/** Telegram channel over long polling (no webhook, so no public URL is needed). */
export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private readonly bot: BotLike;
  private started = false;

  constructor(token: string, bot?: BotLike) {
    this.bot = bot ?? (new Bot(token) as unknown as BotLike);
  }

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    this.bot.on("message", async (ctx) => {
      const m = ctx.message;
      if (!m?.from) return; // anonymous or channel posts can never be the owner
      const inbound: InboundMessage = {
        channel: this.name,
        channelUserId: String(m.from.id),
        chatId: String(m.chat.id),
        isPrivate: m.chat.type === "private",
        text: m.text ?? null,
        receivedAt: new Date(m.date * 1000),
      };
      try {
        await onMessage(inbound);
      } catch (err) {
        // Never let one bad message break the polling loop; log the kind of error only.
        console.error("[telegram] message handler failed:", err instanceof Error ? err.name : "unknown error");
      }
    });

    await this.bot.init(); // verifies the token, so a wrong one fails here with a clear error
    this.started = true;
    void this.bot.start().catch((err: unknown) => {
      this.started = false;
      console.error("[telegram] polling stopped:", err instanceof Error ? err.message : err);
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.bot.stop();
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.bot.api.sendMessage(chatId, text);
  }
}
