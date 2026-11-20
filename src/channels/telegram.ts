import { Bot } from "grammy";
import type { Action, ChannelAdapter, InboundAction, InboundMessage } from "../gateway/types.js";

/** The part of a grammY message context this adapter reads. */
export interface TelegramContext {
  message?: {
    text?: string;
    date: number;
    chat: { id: number; type: string };
    from?: { id: number };
  };
  /** Present on button taps (the "callback_query:data" event). */
  callbackQuery?: {
    data?: string;
    from: { id: number };
    message?: { chat: { id: number; type: string } };
  };
  answerCallbackQuery?(): Promise<unknown>;
}

/** The slice of grammY's Bot this adapter uses, so tests can inject a fake. */
export interface BotLike {
  init(): Promise<unknown>;
  on(event: "message" | "callback_query:data", handler: (ctx: TelegramContext) => Promise<void> | void): unknown;
  /** Long polling: resolves only once the bot is stopped. */
  start(): Promise<void>;
  stop(): Promise<void>;
  api: { sendMessage(chatId: number | string, text: string, other?: object): Promise<unknown> };
}

/** Telegram channel over long polling (no webhook, so no public URL is needed). */
export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  private readonly bot: BotLike;
  private started = false;

  constructor(token: string, bot?: BotLike) {
    this.bot = bot ?? (new Bot(token) as unknown as BotLike);
  }

  async start(
    onMessage: (m: InboundMessage) => Promise<void>,
    onAction?: (a: InboundAction) => Promise<void>,
  ): Promise<void> {
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

    if (onAction) {
      this.bot.on("callback_query:data", async (ctx) => {
        const q = ctx.callbackQuery;
        try {
          if (q?.data && q.message) {
            await onAction({
              channel: this.name,
              channelUserId: String(q.from.id),
              chatId: String(q.message.chat.id),
              isPrivate: q.message.chat.type === "private",
              actionId: q.data,
              receivedAt: new Date(),
            });
          }
        } catch (err) {
          console.error("[telegram] action handler failed:", err instanceof Error ? err.name : "unknown error");
        } finally {
          // Always answer, or the button keeps spinning in the app.
          await ctx.answerCallbackQuery?.().catch(() => {});
        }
      });
    }

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

  async sendWithActions(chatId: string, text: string, actions: Action[]): Promise<void> {
    await this.bot.api.sendMessage(chatId, text, {
      reply_markup: { inline_keyboard: [actions.map((a) => ({ text: a.label, callback_data: a.id }))] },
    });
  }
}
