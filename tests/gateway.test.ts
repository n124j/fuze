import { beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError } from "../src/budget/guard.js";
import { openDb } from "../src/db.js";
import { Gateway } from "../src/gateway/gateway.js";
import { OwnerRegistry } from "../src/gateway/owner.js";
import type { ChannelAdapter, InboundMessage } from "../src/gateway/types.js";

class FakeAdapter implements ChannelAdapter {
  name = "telegram";
  sent: { chatId: string; text: string }[] = [];
  failSend = false;
  private handler: ((m: InboundMessage) => Promise<void>) | null = null;
  async start(onMessage: (m: InboundMessage) => Promise<void>) {
    this.handler = onMessage;
  }
  async stop() {}
  async send(chatId: string, text: string) {
    if (this.failSend) throw new Error("telegram is down");
    this.sent.push({ chatId, text });
  }
  emit(m: InboundMessage) {
    return this.handler!(m);
  }
}

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channel: "telegram",
  channelUserId: "42",
  chatId: "42",
  isPrivate: true,
  text: "hello",
  receivedAt: new Date("2026-11-20T15:00:00Z"),
  ...over,
});

let adapter: FakeAdapter;
let owners: OwnerRegistry;
let respond: ReturnType<typeof vi.fn<(sessionId: string, text: string) => Promise<string>>>;
let gateway: Gateway;

beforeEach(async () => {
  const db = openDb(":memory:");
  adapter = new FakeAdapter();
  owners = new OwnerRegistry(db);
  owners.setOwner("telegram", "42", "42");
  respond = vi.fn(async () => "pong");
  gateway = new Gateway({ owners, adapters: [adapter], respond, db });
  await gateway.start();
});

describe("Gateway ignores everyone but the owner", () => {
  it("drops a stranger's message with no reply and no model call", async () => {
    await adapter.emit(msg({ channelUserId: "666", chatId: "666" }));
    expect(respond).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([]);
  });

  it("drops the owner's message in a group chat", async () => {
    await adapter.emit(msg({ isPrivate: false, chatId: "-100" }));
    expect(respond).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([]);
  });

  it("stays silent when a stranger sends /pair with a wrong code", async () => {
    await adapter.emit(msg({ channelUserId: "666", chatId: "666", text: "/pair wrong" }));
    expect(respond).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([]);
  });

  it("ignores /pair sent in a group, even with a valid code", async () => {
    const code = owners.createPairingCode();
    await adapter.emit(msg({ channelUserId: "666", chatId: "-5", isPrivate: false, text: `/pair ${code}` }));
    expect(owners.isOwner("telegram", "666")).toBe(false);
    expect(adapter.sent).toEqual([]);
  });
});

describe("Gateway pairing", () => {
  it("pairs a new owner with a valid code and then answers them", async () => {
    const code = owners.createPairingCode();
    await adapter.emit(msg({ channelUserId: "77", chatId: "77", text: `/pair ${code}` }));
    expect(adapter.sent).toEqual([{ chatId: "77", text: "Paired." }]);
    await adapter.emit(msg({ channelUserId: "77", chatId: "77", text: "hi" }));
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("does not let a used code pair a second person", async () => {
    const code = owners.createPairingCode();
    await adapter.emit(msg({ channelUserId: "77", chatId: "77", text: `/pair ${code}` }));
    adapter.sent.length = 0;
    await adapter.emit(msg({ channelUserId: "88", chatId: "88", text: `/pair ${code}` }));
    expect(adapter.sent).toEqual([]);
    expect(owners.isOwner("telegram", "88")).toBe(false);
  });
});

describe("Gateway replies", () => {
  it("passes the owner's text to respond with a stable per-chat session id and sends the answer", async () => {
    await adapter.emit(msg());
    expect(respond).toHaveBeenCalledWith("telegram:42", "hello");
    expect(adapter.sent).toEqual([{ chatId: "42", text: "pong" }]);
  });

  it("answers non-text messages politely without calling the model", async () => {
    await adapter.emit(msg({ text: null }));
    expect(respond).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([{ chatId: "42", text: "I can only read text for now." }]);
  });

  it("treats a blank message as non-text", async () => {
    await adapter.emit(msg({ text: "   " }));
    expect(respond).not.toHaveBeenCalled();
    expect(adapter.sent).toHaveLength(1);
  });

  it("splits a 9000-character reply into chunks of at most 4096 characters", async () => {
    const long = "a".repeat(9000);
    respond.mockResolvedValueOnce(long);
    await adapter.emit(msg());
    expect(adapter.sent).toHaveLength(3);
    expect(adapter.sent.every((s) => s.text.length <= 4096)).toBe(true);
    expect(adapter.sent.map((s) => s.text).join("")).toBe(long);
  });

  it("prefers to split a long reply at a line break", async () => {
    const long = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    respond.mockResolvedValueOnce(long);
    await adapter.emit(msg());
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[0]!.text.endsWith("a")).toBe(true);
    expect(adapter.sent[1]!.text.startsWith("b")).toBe(true);
  });

  it("tells the owner when the daily budget is used up", async () => {
    respond.mockRejectedValueOnce(new BudgetExhaustedError());
    await adapter.emit(msg());
    expect(adapter.sent).toEqual([
      { chatId: "42", text: "Budget reached for today; I'll resume at midnight." },
    ]);
  });

  it("apologises instead of crashing when something else goes wrong", async () => {
    respond.mockRejectedValueOnce(new Error("secret email body leaked into error"));
    await expect(adapter.emit(msg())).resolves.toBeUndefined();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.text).not.toContain("secret");
  });

  it("does not throw when the channel itself fails to deliver", async () => {
    adapter.failSend = true;
    await expect(adapter.emit(msg())).resolves.toBeUndefined();
  });

  it("handles one chat's messages in order, one at a time", async () => {
    const order: string[] = [];
    respond.mockImplementation(async (_s, text) => {
      order.push(`start ${text}`);
      await new Promise((r) => setTimeout(r, text === "first" ? 30 : 1));
      order.push(`end ${text}`);
      return text;
    });
    await Promise.all([adapter.emit(msg({ text: "first" })), adapter.emit(msg({ text: "second" }))]);
    expect(order).toEqual(["start first", "end first", "start second", "end second"]);
  });
});
