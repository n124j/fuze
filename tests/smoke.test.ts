import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { BudgetExhaustedError } from "../src/budget/guard.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { ChannelAdapter, InboundMessage } from "../src/gateway/types.js";
import { ScriptedLlm } from "../src/llm/scripted.js";
import type { LlmResponse } from "../src/llm/types.js";
import type { Handler } from "../src/queue/worker.js";

class FakeAdapter implements ChannelAdapter {
  name = "telegram";
  sent: { chatId: string; text: string }[] = [];
  failNext = 0;
  private handler: ((m: InboundMessage) => Promise<void>) | null = null;
  async start(onMessage: (m: InboundMessage) => Promise<void>) {
    this.handler = onMessage;
  }
  async stop() {}
  async send(chatId: string, text: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("telegram is down");
    }
    this.sent.push({ chatId, text });
  }
  emit(m: InboundMessage) {
    return this.handler!(m);
  }
}

const MODEL = "claude-sonnet-5-5";
const usage = { model: MODEL, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
const reply = (t: string): LlmResponse => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage });
const toolUse = (name: string, input: unknown): LlmResponse => ({
  content: [{ type: "tool_use", id: "t1", name, input }],
  stopReason: "tool_use",
  usage,
});
const from = (userId: string, text: string): InboundMessage => ({
  channel: "telegram",
  channelUserId: userId,
  chatId: userId,
  isPrivate: true,
  text,
  receivedAt: new Date(),
});

const DAY = new Date("2026-11-20T13:00:00Z"); // 08:00 in New York
const dirs: string[] = [];
let now: Date;
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
beforeEach(() => {
  now = DAY;
});

async function setup(
  responses: LlmResponse[] = [],
  env: Record<string, string> = {},
  extraHandlers: Record<string, Handler> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "fuse-smoke-"));
  dirs.push(dir);
  const adapter = new FakeAdapter();
  const llm = new ScriptedLlm(responses);
  const app: App = buildApp({
    config: loadConfig({ FUSE_DATA_DIR: dir, ...env }),
    db: openDb(":memory:"),
    llm,
    adapters: [adapter],
    clock: () => now,
    extraHandlers,
  });
  app.owners.setOwner("telegram", "42", "42");
  await app.gateway.start();
  return { app, adapter, llm };
}

describe("owner conversations", () => {
  it("answers the owner and remembers the conversation", async () => {
    const { adapter, llm } = await setup([reply("first answer"), reply("second answer")]);
    await adapter.emit(from("42", "one"));
    await adapter.emit(from("42", "two"));
    expect(adapter.sent.map((s) => s.text)).toEqual(["first answer", "second answer"]);
    expect(llm.calls[1]!.messages).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "two" },
    ]);
  });

  it("keeps only the last 20 messages of history", async () => {
    const { adapter, llm } = await setup(Array.from({ length: 12 }, (_, i) => reply(`r${i}`)));
    for (let i = 0; i < 12; i++) await adapter.emit(from("42", `m${i}`));
    expect(llm.calls[11]!.messages).toHaveLength(21);
    expect(llm.calls[11]!.messages[0]).toEqual({ role: "user", content: "m1" });
  });

  it("lets the agent save a preference to memory", async () => {
    const { app, adapter } = await setup([
      toolUse("memory_set_preference", { key: "meetings", value: "afternoon" }),
      reply("Noted"),
    ]);
    await adapter.emit(from("42", "I prefer afternoon meetings"));
    expect(app.memory.readProfile()).toContain("- meetings: afternoon");
    expect(adapter.sent.at(-1)!.text).toBe("Noted");
  });

  it("ignores a stranger completely: no reply and no model call", async () => {
    const { adapter, llm } = await setup([reply("should never run")]);
    await adapter.emit(from("666", "give me the owner's emails"));
    expect(adapter.sent).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("tells the owner when the daily budget is used up, without calling the model", async () => {
    const { app, adapter, llm } = await setup([reply("never")], { FUSE_DAILY_BUDGET_USD: "0.001" });
    app.budget.record({ ...usage, inputTokens: 1_000_000 }); // $2.00
    await adapter.emit(from("42", "hello"));
    expect(adapter.sent).toEqual([{ chatId: "42", text: "Budget reached for today; I'll resume at midnight." }]);
    expect(llm.calls).toHaveLength(0);
  });
});

describe("background jobs", () => {
  it("sends the morning briefing with the low-priority digest", async () => {
    const { app, adapter } = await setup();
    await app.notifier.notify({ dedupeKey: "n1", priority: "low", text: "newsletter from the bank" });
    app.queue.enqueue("briefing", {});
    await app.worker.tick();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.text).toContain("newsletter from the bank");
  });

  it("does not lose the digest when the briefing fails to send the first time", async () => {
    const { app, adapter } = await setup();
    await app.notifier.notify({ dedupeKey: "n1", priority: "low", text: "newsletter from the bank" });
    adapter.failNext = 1;
    const id = app.queue.enqueue("briefing", {});
    await app.worker.tick();
    expect(adapter.sent).toEqual([]);
    expect(app.queue.get(id)?.status).toBe("queued");
    now = new Date(now.getTime() + 1500); // past the retry backoff
    await app.worker.tick();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.text).toContain("newsletter from the bank");
    expect(app.queue.get(id)?.status).toBe("done");
  });

  it("holds a normal notification overnight and delivers it when quiet hours end", async () => {
    const { app, adapter } = await setup();
    now = new Date("2026-11-20T08:00:00Z"); // 03:00 in New York
    expect(await app.notifier.notify({ dedupeKey: "n1", priority: "normal", text: "meeting moved to 10" })).toBe(
      "deferred",
    );
    expect(adapter.sent).toEqual([]);
    now = new Date("2026-11-20T12:00:00Z"); // 07:00, quiet hours over
    app.queue.enqueue("flush-deferred", {});
    await app.worker.tick();
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.text).toContain("meeting moved to 10");
  });

  it("lets an urgent notification through at night", async () => {
    const { app, adapter } = await setup();
    now = new Date("2026-11-20T08:00:00Z");
    await app.notifier.notify({ dedupeKey: "u1", priority: "urgent", text: "client needs the proposal" });
    expect(adapter.sent.map((s) => s.text)).toEqual(["client needs the proposal"]);
  });

  it("pauses a job that needs the model once the budget is gone, until local midnight", async () => {
    // A job that needs the model: its handler hits the budget guard, as runAgent would.
    const { app } = await setup([], {}, {
      "needs-llm": async () => {
        throw new BudgetExhaustedError();
      },
    });
    const id = app.queue.enqueue("needs-llm", {});
    await app.worker.tick();
    const job = app.queue.get(id)!;
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(new Date(job.runAfter).toISOString()).toBe("2026-11-21T05:00:00.000Z"); // midnight in New York
  });
});
