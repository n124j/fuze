import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { Gateway, sendWithFallback } from "../src/gateway/gateway.js";
import { OwnerRegistry } from "../src/gateway/owner.js";
import type { Action, ChannelAdapter, InboundAction, InboundMessage } from "../src/gateway/types.js";

class FakeAdapter implements ChannelAdapter {
  name = "telegram";
  sent: { chatId: string; text: string }[] = [];
  withActions: { chatId: string; text: string; actions: Action[] }[] = [];
  private onMessage: ((m: InboundMessage) => Promise<void>) | null = null;
  private onAction: ((a: InboundAction) => Promise<void>) | undefined;
  async start(onMessage: (m: InboundMessage) => Promise<void>, onAction?: (a: InboundAction) => Promise<void>) {
    this.onMessage = onMessage;
    this.onAction = onAction;
  }
  async stop() {}
  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  async sendWithActions(chatId: string, text: string, actions: Action[]) {
    this.withActions.push({ chatId, text, actions });
  }
  say(m: Partial<InboundMessage>) {
    return this.onMessage!({
      channel: "telegram",
      channelUserId: "42",
      chatId: "42",
      isPrivate: true,
      text: "hi",
      receivedAt: new Date(),
      ...m,
    });
  }
  tap(a: Partial<InboundAction>) {
    return this.onAction!({
      channel: "telegram",
      channelUserId: "42",
      chatId: "42",
      isPrivate: true,
      actionId: "approve:abc",
      receivedAt: new Date(),
      ...a,
    });
  }
}

let adapter: FakeAdapter;
let respond: ReturnType<typeof vi.fn<(s: string, t: string) => Promise<string>>>;
let onAction: ReturnType<typeof vi.fn<(a: InboundAction) => Promise<string>>>;

beforeEach(async () => {
  const db = openDb(":memory:");
  adapter = new FakeAdapter();
  const owners = new OwnerRegistry(db);
  owners.setOwner("telegram", "42", "42");
  respond = vi.fn(async () => "chat reply");
  onAction = vi.fn(async () => "Sent.");
  await new Gateway({ owners, adapters: [adapter], respond, db, onAction }).start();
});

describe("Gateway actions", () => {
  it("passes the owner's tap to onAction and sends back its answer", async () => {
    await adapter.tap({});
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: "approve:abc", chatId: "42" }));
    expect(adapter.sent).toEqual([{ chatId: "42", text: "Sent." }]);
  });

  it("ignores a tap from anyone else", async () => {
    await adapter.tap({ channelUserId: "666", chatId: "666" });
    expect(onAction).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([]);
  });

  it("ignores a tap in a group, even from the owner", async () => {
    await adapter.tap({ isPrivate: false, chatId: "-100" });
    expect(onAction).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([]);
  });

  it("answers generically when handling a tap fails", async () => {
    onAction.mockRejectedValueOnce(new Error("boom with private text"));
    await adapter.tap({});
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.text).not.toContain("private text");
  });

  it("treats the owner's /approve and /reject as taps and never sends them to the model", async () => {
    await adapter.say({ text: "/approve abc123" });
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ actionId: "approve:abc123" }));
    await adapter.say({ text: "/reject abc123" });
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ actionId: "reject:abc123" }));
    expect(respond).not.toHaveBeenCalled();
  });

  it("ignores /approve from a stranger", async () => {
    await adapter.say({ channelUserId: "666", chatId: "666", text: "/approve abc123" });
    expect(onAction).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(adapter.sent).toEqual([]);
  });
});

describe("sendWithFallback", () => {
  const actions: Action[] = [
    { id: "approve:x1", label: "Approve" },
    { id: "reject:x1", label: "Reject" },
  ];

  it("uses buttons when the adapter has them", async () => {
    await sendWithFallback(adapter, "42", "Approve?", actions);
    expect(adapter.withActions).toEqual([{ chatId: "42", text: "Approve?", actions }]);
    expect(adapter.sent).toEqual([]);
  });

  it("falls back to slash commands in plain text", async () => {
    const plain: ChannelAdapter = { name: "cli", start: async () => {}, stop: async () => {}, send: vi.fn(async () => {}) };
    await sendWithFallback(plain, "local", "Approve?", actions);
    const text = vi.mocked(plain.send).mock.calls[0]![1];
    expect(text).toContain("Approve?");
    expect(text).toContain("/approve x1");
    expect(text).toContain("/reject x1");
  });
});
