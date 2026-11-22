import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type App } from "../src/app.js";
import { BudgetExhaustedError } from "../src/budget/guard.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import type { Action, ChannelAdapter, InboundAction, InboundMessage } from "../src/gateway/types.js";
import { ScriptedLlm } from "../src/llm/scripted.js";
import type { LlmResponse } from "../src/llm/types.js";
import type { Handler } from "../src/queue/worker.js";

class FakeAdapter implements ChannelAdapter {
  name = "telegram";
  sent: { chatId: string; text: string }[] = [];
  failNext = 0;
  withActions: { chatId: string; text: string; actions: Action[] }[] = [];
  private handler: ((m: InboundMessage) => Promise<void>) | null = null;
  private actionHandler: ((a: InboundAction) => Promise<void>) | undefined;
  async start(onMessage: (m: InboundMessage) => Promise<void>, onAction?: (a: InboundAction) => Promise<void>) {
    this.handler = onMessage;
    this.actionHandler = onAction;
  }
  async sendWithActions(chatId: string, text: string, actions: Action[]) {
    this.withActions.push({ chatId, text, actions });
  }
  tap(actionId: string, userId = "42") {
    return this.actionHandler!({
      channel: "telegram",
      channelUserId: userId,
      chatId: userId,
      isPrivate: true,
      actionId,
      receivedAt: new Date(),
    });
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
  google?: any,
  extra: { apple?: any; slack?: any } = {},
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
    google,
    apple: extra.apple,
    slack: extra.slack,
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

describe("startup safety", () => {
  it("refuses to start with a model that has no price, so spend can never go unrecorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fuse-smoke-"));
    dirs.push(dir);
    expect(() =>
      buildApp({
        config: loadConfig({ FUSE_DATA_DIR: dir, FUSE_MODEL_STRONG: "claude-unpriced-model" }),
        db: openDb(":memory:"),
        llm: new ScriptedLlm([]),
        adapters: [new FakeAdapter()],
        clock: () => now,
      }),
    ).toThrow(/claude-unpriced-model/);
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

function fakeGoogle() {
  return {
    gmail: {
      readMessage: vi.fn(async () => "body"),
      createDraft: vi.fn(async () => ({ draftId: "d1" })),
      getDraft: vi.fn(async () => ({ to: ["ann@x.com"], cc: [], subject: "Lunch", body: "See you at noon" })),
      sendDraft: vi.fn(async () => ({ messageId: "m-sent" })),
      currentHistoryId: vi.fn(async () => "100"),
      newMessagesSince: vi.fn(async () => ({ items: [] as any[], historyId: "100" })),
      counts: vi.fn(async () => ({ inboxTotal: 10, inboxUnread: 2 })),
      search: vi.fn(async () => ({ total: 0, exact: true, items: [] as any[] })),
      listIds: vi.fn(async () => ({ ids: ["m1", "m2"], more: false })),
      summaries: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, from: "Ann <ann@x.com>", subject: `Old ${id}`, date: DAY, unread: false }))),
      trash: vi.fn(async (_ids: string[]) => {}),
    },
    calendar: { listBetween: vi.fn(async () => [] as any[]), createEvent: vi.fn() },
    tasks: { listOpen: vi.fn(async () => [] as any[]), create: vi.fn() },
    drive: { search: vi.fn(async () => []), readText: vi.fn(async () => "") },
  };
}

const newMail = (id: string, from: string, subject: string, isBulk = false) => ({
  id,
  threadId: "t-" + id,
  from,
  subject,
  snippet: "",
  receivedAt: DAY,
  labels: ["INBOX"],
  isBulk,
});

describe("google: drafts and approval", () => {
  it("saves a draft and never sends it by itself", async () => {
    const google = fakeGoogle();
    const { adapter } = await setup(
      [toolUse("email_draft", { to: ["ann@x.com"], subject: "Lunch", body: "See you at noon" }), reply("Draft saved")],
      {},
      {},
      google,
    );
    await adapter.emit(from("42", "draft a lunch note to Ann"));
    expect(google.gmail.createDraft).toHaveBeenCalledTimes(1);
    expect(google.gmail.sendDraft).not.toHaveBeenCalled();
  });

  async function requestSend() {
    const google = fakeGoogle();
    const ctx = await setup([toolUse("email_request_send", { draftId: "d1" }), reply("Asked you")], {}, {}, google);
    await ctx.adapter.emit(from("42", "send that draft"));
    return { ...ctx, google };
  }

  it("asks the owner with Approve and Reject buttons, and sends nothing yet", async () => {
    const { adapter, google } = await requestSend();
    expect(adapter.withActions).toHaveLength(1);
    expect(adapter.withActions[0]!.text).toContain("ann@x.com");
    expect(adapter.withActions[0]!.text).toContain("See you at noon");
    expect(adapter.withActions[0]!.actions.map((a) => a.label)).toEqual(["Approve", "Reject"]);
    expect(google.gmail.sendDraft).not.toHaveBeenCalled();
  });

  it("sends exactly once when the owner taps Approve", async () => {
    const { adapter, google } = await requestSend();
    const approve = adapter.withActions[0]!.actions[0]!.id;
    await adapter.tap(approve);
    expect(google.gmail.sendDraft).toHaveBeenCalledTimes(1);
    expect(adapter.sent.at(-1)!.text).toBe("Sent.");
    await adapter.tap(approve);
    expect(google.gmail.sendDraft).toHaveBeenCalledTimes(1);
  });

  it("moves emails to Trash only after the owner taps Approve", async () => {
    const google = fakeGoogle();
    const { adapter } = await setup([toolUse("email_request_trash", { query: "older_than:1y" }), reply("Asked you")], {}, {}, google);
    await adapter.emit(from("42", "clean out old mail"));
    expect(adapter.withActions[0]!.text).toContain("Move 2 emails to Trash");
    expect(google.gmail.trash).not.toHaveBeenCalled();
    const approve = adapter.withActions[0]!.actions[0]!.id;
    await adapter.tap(approve);
    expect(google.gmail.trash).toHaveBeenCalledWith(["m1", "m2"]);
    expect(adapter.sent.at(-1)!.text).toContain("Moved 2 emails to Trash");
    await adapter.tap(approve);
    expect(google.gmail.trash).toHaveBeenCalledTimes(1);
  });

  it("does nothing when a stranger taps Approve", async () => {
    const { adapter, google } = await requestSend();
    const before = adapter.sent.length;
    await adapter.tap(adapter.withActions[0]!.actions[0]!.id, "666");
    expect(google.gmail.sendDraft).not.toHaveBeenCalled();
    expect(adapter.sent).toHaveLength(before);
  });

  it("does not send a draft that was edited after the request", async () => {
    const { adapter, google } = await requestSend();
    google.gmail.getDraft.mockResolvedValue({ to: ["ann@x.com", "evil@x.com"], cc: [], subject: "Lunch", body: "See you at noon" });
    await adapter.tap(adapter.withActions[0]!.actions[0]!.id);
    expect(google.gmail.sendDraft).not.toHaveBeenCalled();
    expect(adapter.sent.at(-1)!.text).toMatch(/changed/i);
  });
});

describe("google: polling and briefing", () => {
  it("delivers a VIP email at once and holds a newsletter for the briefing", async () => {
    const google = fakeGoogle();
    const { app, adapter, llm } = await setup([reply("Good morning. Your day is clear.")], { FUSE_VIP_SENDERS: "boss@corp.com" }, {}, google);
    app.queue.enqueue("poll", {});
    await app.worker.tick(); // first poll: records where the mailbox is
    google.gmail.newMessagesSince.mockResolvedValue({
      items: [newMail("m1", "Boss <boss@corp.com>", "Call me"), newMail("m2", "Deals <news@shop.com>", "50% off", true)],
      historyId: "110",
    });
    app.queue.enqueue("poll", {});
    await app.worker.tick();
    expect(adapter.sent.map((s) => s.text)).toEqual(["Email from Boss <boss@corp.com>: Call me (from Boss <boss@corp.com>)"]);
    app.queue.enqueue("briefing", {});
    await app.worker.tick();
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain("50% off"); // the held newsletter went into the briefing
    expect(adapter.sent.at(-1)!.text).toContain("Your day is clear.");
  });

  it("puts today's calendar into the morning briefing", async () => {
    const google = fakeGoogle();
    google.calendar.listBetween.mockResolvedValue([
      { id: "e1", title: "Standup", start: new Date("2026-11-20T14:00:00Z"), end: new Date("2026-11-20T14:30:00Z"), allDay: false, updated: new Date(0) },
    ]);
    const { app, adapter, llm } = await setup([reply("Good morning. Standup at 09:00.")], {}, {}, google);
    app.queue.enqueue("briefing", {});
    await app.worker.tick();
    expect(JSON.stringify(llm.calls[0]!.messages)).toContain("09:00 Standup");
    expect(adapter.sent.at(-1)!.text).toContain("Standup at 09:00.");
  });

  it("does not call the model twice for one briefing when the first send fails", async () => {
    const google = fakeGoogle();
    google.tasks.listOpen.mockResolvedValue([{ id: "t1", title: "Pay rent", done: false }]);
    const { app, adapter, llm } = await setup([reply("Good morning. Pay rent.")], {}, {}, google);
    adapter.failNext = 1;
    const id = app.queue.enqueue("briefing", {});
    await app.worker.tick();
    now = new Date(now.getTime() + 1500);
    await app.worker.tick();
    expect(app.queue.get(id)?.status).toBe("done");
    expect(llm.calls).toHaveLength(1);
    expect(adapter.sent.at(-1)!.text).toContain("Pay rent");
  });
});

describe("apple and slack", () => {
  const sync = { id: "g1", uid: "u1", title: "Sync", start: new Date("2026-11-20T14:00:00Z"), end: new Date("2026-11-20T14:30:00Z"), allDay: false, updated: new Date(0) };
  const fakeApple = (events: any[] = []) => ({
    calendar: { listBetween: vi.fn(async () => events) },
    reminders: { listOpen: vi.fn(async () => [] as any[]), create: vi.fn() },
  });
  const slackItem = { key: "D1:1800000100.0", kind: "dm", from: "sam", where: "direct message", text: "hi there", ts: 1800000100 };
  const fakeSlack = () => ({ client: { findNew: vi.fn(async () => [] as any[]), search: vi.fn(async () => []) }, userId: "U_ME" });

  it("announces an event that is in both Google and Apple Calendar once", async () => {
    const google = fakeGoogle();
    google.calendar.listBetween.mockResolvedValue([sync]);
    const apple = fakeApple([{ ...sync, id: "apple:u1" }]);
    const { app, adapter } = await setup([], {}, {}, google, { apple });
    app.queue.enqueue("poll", {});
    await app.worker.tick();
    expect(adapter.sent.filter((s) => s.text.includes("Sync starts in"))).toHaveLength(1);
  });

  it("still polls Google when Apple Calendar fails", async () => {
    const google = fakeGoogle();
    google.calendar.listBetween.mockResolvedValue([sync]);
    const apple = fakeApple();
    apple.calendar.listBetween.mockRejectedValue(new Error("osascript timed out"));
    const { app, adapter } = await setup([], {}, {}, google, { apple });
    app.queue.enqueue("poll", {});
    await app.worker.tick();
    expect(adapter.sent.some((s) => s.text.includes("Sync starts in"))).toBe(true);
  });

  it("delivers a Slack direct message once", async () => {
    const slack = fakeSlack();
    const { app, adapter } = await setup([], {}, {}, undefined, { slack });
    app.queue.enqueue("poll", {});
    await app.worker.tick(); // first poll only records the starting point
    slack.client.findNew.mockResolvedValue([slackItem]);
    app.queue.enqueue("poll", {});
    await app.worker.tick();
    app.queue.enqueue("poll", {});
    await app.worker.tick();
    expect(adapter.sent.map((s) => s.text)).toEqual(["Slack DM from sam: hi there"]);
  });

  it("keeps the calendar poll going when Slack is rate limited, and retries the job", async () => {
    const google = fakeGoogle();
    google.calendar.listBetween.mockResolvedValue([sync]);
    const slack = fakeSlack();
    const { SlackApiError } = await import("../src/slack/client.js");
    slack.client.findNew.mockRejectedValue(new SlackApiError("slow down", 429, "ratelimited"));
    const { app, adapter } = await setup([], {}, {}, google, { slack });
    app.queue.enqueue("poll", {});
    await app.worker.tick(); // slack baseline
    const id = app.queue.enqueue("poll", {});
    await app.worker.tick();
    expect(adapter.sent.some((s) => s.text.includes("Sync starts in"))).toBe(true);
    expect(app.queue.get(id)!.status).not.toBe("done");
  });

  it("registers reminder and slack tools only when those connectors exist", async () => {
    const bare = await setup([]);
    const names = (a: { app: App }) => a.app.tools.specs().map((t) => t.name);
    expect(names(bare)).not.toContain("reminders_create");
    expect(names(bare)).not.toContain("slack_search");
    const full = await setup([], {}, {}, undefined, { apple: fakeApple(), slack: fakeSlack() });
    expect(names(full)).toEqual(expect.arrayContaining(["reminders_list", "reminders_create", "slack_search"]));
  });
});

describe("memory consolidation job", () => {
  it("tidies memory, tells the owner, and does not pay twice when the send fails once", async () => {
    const edits = JSON.stringify({ add: ["Prefers mornings"], remove: ["- old fact"], summary: "Merged 1, added 1" });
    const { app, adapter, llm } = await setup([reply(edits)]);
    app.memory.appendLongTerm("old fact");
    app.memory.appendLongTerm("keeper");
    app.memory.appendDaily("asked for mornings", now);
    adapter.failNext = 1;
    const id = app.queue.enqueue("consolidate", {});
    await app.worker.tick();
    now = new Date(now.getTime() + 1500);
    await app.worker.tick();
    expect(app.queue.get(id)?.status).toBe("done");
    expect(llm.calls).toHaveLength(1);
    expect(app.memory.readLongTerm()).toBe("- keeper\n- Prefers mornings\n");
    expect(adapter.sent.at(-1)!.text).toBe("Memory tidy-up: Merged 1, added 1");
  });

  it("tells the owner when it skips a tidy-up it did not trust", async () => {
    const wipe = JSON.stringify({ add: [], remove: ["- a", "- b"], summary: "wipe" });
    const { app, adapter } = await setup([reply(wipe)]);
    app.memory.appendLongTerm("a");
    app.memory.appendLongTerm("b");
    app.queue.enqueue("consolidate", {});
    await app.worker.tick();
    expect(app.memory.readLongTerm()).toBe("- a\n- b\n");
    expect(adapter.sent.at(-1)!.text).toContain("I skipped this week's memory tidy-up");
  });
});
