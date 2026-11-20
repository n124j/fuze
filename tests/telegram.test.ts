import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboundAction, InboundMessage } from "../src/gateway/types.js";
import { TelegramAdapter, type BotLike, type TelegramContext } from "../src/channels/telegram.js";

class FakeBot implements BotLike {
  handlers = new Map<string, (ctx: TelegramContext) => Promise<void> | void>();
  init = vi.fn(async () => ({}));
  start = vi.fn(() => new Promise<void>(() => {})); // long polling: never settles in the test
  stop = vi.fn(async () => {});
  api = { sendMessage: vi.fn(async (_chatId: number | string, _text: string, _other?: object) => ({})) };
  on(event: "message" | "callback_query:data", handler: (ctx: TelegramContext) => Promise<void> | void) {
    this.handlers.set(event, handler);
  }
  deliver(message: TelegramContext["message"]) {
    return this.handlers.get("message")!({ message });
  }
  tap(data: string, over: Record<string, unknown> = {}) {
    const answer = vi.fn(async () => true);
    const done = this.handlers.get("callback_query:data")!({
      callbackQuery: { data, from: { id: 42 }, message: { chat: { id: 42, type: "private" } }, ...over },
      answerCallbackQuery: answer,
    });
    return { done, answer };
  }
}

const DATE = 1_795_000_000; // seconds
const textMessage = (over: Record<string, unknown> = {}) => ({
  text: "hello",
  date: DATE,
  chat: { id: 42, type: "private" },
  from: { id: 42 },
  ...over,
});

let bot: FakeBot;
let adapter: TelegramAdapter;
let seen: InboundMessage[];

beforeEach(async () => {
  bot = new FakeBot();
  adapter = new TelegramAdapter("123:fake-token", bot);
  seen = [];
  await adapter.start(async (m) => void seen.push(m));
});

describe("TelegramAdapter inbound", () => {
  it("maps a private text message to the common shape", async () => {
    await bot.deliver(textMessage());
    expect(seen).toEqual([
      {
        channel: "telegram",
        channelUserId: "42",
        chatId: "42",
        isPrivate: true,
        text: "hello",
        receivedAt: new Date(DATE * 1000),
      },
    ]);
  });

  it("marks a non-text message (photo, sticker) with null text", async () => {
    await bot.deliver(textMessage({ text: undefined }));
    expect(seen[0]!.text).toBeNull();
  });

  it("marks group chats as not private", async () => {
    await bot.deliver(textMessage({ chat: { id: -100123, type: "supergroup" } }));
    await bot.deliver(textMessage({ chat: { id: -5, type: "group" } }));
    expect(seen.map((m) => m.isPrivate)).toEqual([false, false]);
    expect(seen[0]!.chatId).toBe("-100123");
  });

  it("ignores messages that carry no sender", async () => {
    await bot.deliver(textMessage({ from: undefined }));
    expect(seen).toEqual([]);
  });

  it("ignores updates that have no message", async () => {
    await bot.deliver(undefined);
    expect(seen).toEqual([]);
  });

  it("does not let a failing message handler escape into the polling loop", async () => {
    const failing = new FakeBot();
    const a = new TelegramAdapter("t", failing);
    await a.start(async () => {
      throw new Error("handler blew up");
    });
    await expect(failing.deliver(textMessage())).resolves.toBeUndefined();
  });
});

describe("TelegramAdapter lifecycle", () => {
  it("verifies the token before polling and starts polling", () => {
    expect(bot.init).toHaveBeenCalledTimes(1);
    expect(bot.start).toHaveBeenCalledTimes(1);
    expect(bot.init.mock.invocationCallOrder[0]!).toBeLessThan(bot.start.mock.invocationCallOrder[0]!);
  });

  it("fails fast with the bot's error when the token is rejected", async () => {
    const bad = new FakeBot();
    bad.init.mockRejectedValueOnce(new Error("401 Unauthorized"));
    await expect(new TelegramAdapter("bad", bad).start(async () => {})).rejects.toThrow("401");
    expect(bad.start).not.toHaveBeenCalled();
  });

  it("stops polling on stop, and is harmless if it was never started", async () => {
    await adapter.stop();
    expect(bot.stop).toHaveBeenCalledTimes(1);
    const idle = new FakeBot();
    await new TelegramAdapter("t", idle).stop();
    expect(idle.stop).not.toHaveBeenCalled();
  });

  it("reports its channel name", () => {
    expect(adapter.name).toBe("telegram");
  });
});

describe("TelegramAdapter outbound", () => {
  it("sends plain text to the chat", async () => {
    await adapter.send("42", "hi there");
    expect(bot.api.sendMessage).toHaveBeenCalledWith("42", "hi there");
  });

  it("rejects when Telegram refuses, so the caller can decide what to do", async () => {
    bot.api.sendMessage.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    await expect(adapter.send("42", "x")).rejects.toThrow("429");
  });
});

describe("TelegramAdapter actions", () => {
  it("does not listen for button taps unless a handler was given", () => {
    expect(bot.handlers.has("callback_query:data")).toBe(false);
  });

  it("maps a button tap to an action and stops the spinner", async () => {
    const taps: InboundAction[] = [];
    const b = new FakeBot();
    await new TelegramAdapter("123:fake-token", b).start(async () => {}, async (a) => void taps.push(a));
    const { done, answer } = b.tap("approve:abc");
    await done;
    expect(taps).toEqual([
      expect.objectContaining({ channel: "telegram", channelUserId: "42", chatId: "42", isPrivate: true, actionId: "approve:abc" }),
    ]);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("marks a tap from a group chat as not private", async () => {
    const taps: InboundAction[] = [];
    const b = new FakeBot();
    await new TelegramAdapter("123:fake-token", b).start(async () => {}, async (a) => void taps.push(a));
    await b.tap("approve:abc", { message: { chat: { id: -100, type: "supergroup" } } }).done;
    expect(taps[0]!.isPrivate).toBe(false);
  });

  it("sends an inline keyboard with the actions", async () => {
    await adapter.sendWithActions("42", "Approve?", [
      { id: "approve:x1", label: "Approve" },
      { id: "reject:x1", label: "Reject" },
    ]);
    expect(bot.api.sendMessage).toHaveBeenCalledWith("42", "Approve?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: "approve:x1" },
            { text: "Reject", callback_data: "reject:x1" },
          ],
        ],
      },
    });
  });
});
