import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../src/db.js";
import { GoogleApiError, GoogleAuthError } from "../src/google/auth.js";
import type { CalEvent } from "../src/google/calendar.js";
import { ConnectorState, SeenItems, type MailItem } from "../src/google/gmail.js";
import { PollService } from "../src/poll.js";
import type { Verdict } from "../src/triage/rules.js";

const NOW = new Date("2026-11-20T15:00:00Z"); // 10:00 in New York

const mail = (id: string, over: Partial<MailItem> = {}): MailItem => ({
  id,
  threadId: `t-${id}`,
  from: "Pat <pat@example.com>",
  subject: `Subject ${id}`,
  snippet: "",
  receivedAt: NOW,
  labels: ["INBOX"],
  isBulk: false,
  ...over,
});

const event = (over: Partial<CalEvent> = {}): CalEvent => ({
  id: "e1",
  title: "Board call",
  start: new Date("2026-11-20T17:00:00Z"),
  end: new Date("2026-11-20T18:00:00Z"),
  allDay: false,
  updated: new Date("2026-11-19T00:00:00Z"),
  ...over,
});

let db: Db;
let now: Date;
let gmail: { currentHistoryId: ReturnType<typeof vi.fn>; newMessagesSince: ReturnType<typeof vi.fn> };
let calendar: { listBetween: ReturnType<typeof vi.fn> };
let notify: ReturnType<typeof vi.fn>;
let triage: ReturnType<typeof vi.fn>;
let poll: PollService;

beforeEach(() => {
  db = openDb(":memory:");
  now = NOW;
  gmail = {
    currentHistoryId: vi.fn(async () => "100"),
    newMessagesSince: vi.fn(async () => ({ items: [], historyId: "100" })),
  };
  calendar = { listBetween: vi.fn(async () => []) };
  notify = vi.fn(async () => "sent");
  triage = vi.fn(async (items: MailItem[]) => new Map(items.map((i) => [i.id, { priority: "normal", summary: `sum ${i.id}`, decidedBy: "model" } as Verdict])));
  poll = new PollService({
    gmail: gmail as never,
    calendar: calendar as never,
    seen: new SeenItems(db),
    state: new ConnectorState(db),
    notifier: { notify } as never,
    triage: triage as never,
    vip: ["boss@corp.com"],
    tz: "America/New_York",
    clock: () => now,
  });
});

const notified = () => notify.mock.calls.map((c) => c[0]);

describe("PollService gmail", () => {
  it("only records where the mailbox is on the very first poll, notifying nothing", async () => {
    gmail.newMessagesSince.mockResolvedValue({ items: [mail("old1"), mail("old2")], historyId: "999" });
    expect(await poll.pollOnce()).toEqual({ mail: 0, events: 0 });
    expect(gmail.newMessagesSince).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies each new message once, with the verdict's priority and a stable key", async () => {
    await poll.pollOnce(); // first run: baseline
    gmail.newMessagesSince.mockResolvedValue({ items: [mail("a"), mail("b", { isBulk: true })], historyId: "110" });
    expect(await poll.pollOnce()).toEqual({ mail: 2, events: 0 });
    expect(gmail.newMessagesSince).toHaveBeenCalledWith("100");
    expect(notified()).toEqual([
      { dedupeKey: "gmail:a", priority: "normal", text: "Email from Pat <pat@example.com>: sum a" },
      { dedupeKey: "gmail:b", priority: "low", text: "Email from Pat <pat@example.com>: Subject b" },
    ]);
    expect(triage).toHaveBeenCalledTimes(1);
    expect(triage.mock.calls[0]![0].map((i: MailItem) => i.id)).toEqual(["a"]); // bulk never reaches the model
  });

  it("treats a VIP as urgent without asking the model", async () => {
    await poll.pollOnce();
    gmail.newMessagesSince.mockResolvedValue({ items: [mail("v", { from: "Boss <boss@corp.com>" })], historyId: "110" });
    await poll.pollOnce();
    expect(notified()[0]).toMatchObject({ dedupeKey: "gmail:v", priority: "urgent" });
    expect(triage).not.toHaveBeenCalled();
  });

  it("does not notify again when two polls return the same message", async () => {
    await poll.pollOnce();
    gmail.newMessagesSince.mockResolvedValue({ items: [mail("a")], historyId: "110" });
    await poll.pollOnce();
    expect(await poll.pollOnce()).toEqual({ mail: 0, events: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(triage).toHaveBeenCalledTimes(1);
  });

  it("keeps the history position and loses nothing when a notification fails midway", async () => {
    await poll.pollOnce();
    gmail.newMessagesSince.mockResolvedValue({ items: [mail("a"), mail("b")], historyId: "120" });
    notify.mockResolvedValueOnce("sent").mockRejectedValueOnce(new Error("telegram down"));
    await expect(poll.pollOnce()).rejects.toThrow("telegram down");
    notify.mockResolvedValue("sent");
    await poll.pollOnce();
    expect(gmail.newMessagesSince).toHaveBeenLastCalledWith("100");
    expect(notified().map((n) => n.dedupeKey)).toEqual(["gmail:a", "gmail:b", "gmail:b"]);
    // "a" was recorded as seen after its first delivery, so only "b" is triaged the second time
    expect(triage.mock.calls.map((c) => c[0].map((i: MailItem) => i.id))).toEqual([["a", "b"], ["b"]]);
  });

  it("moves the history position forward after a clean poll", async () => {
    await poll.pollOnce();
    gmail.newMessagesSince.mockResolvedValue({ items: [mail("a")], historyId: "110" });
    await poll.pollOnce();
    gmail.newMessagesSince.mockResolvedValue({ items: [], historyId: "115" });
    await poll.pollOnce();
    expect(gmail.newMessagesSince).toHaveBeenLastCalledWith("110");
  });

  it("resets to now when the history id has expired, with no notifications", async () => {
    await poll.pollOnce();
    gmail.newMessagesSince.mockResolvedValue({ items: [], historyId: "777" });
    await poll.pollOnce();
    expect(notify).not.toHaveBeenCalled();
    await poll.pollOnce();
    expect(gmail.newMessagesSince).toHaveBeenLastCalledWith("777");
  });
});

describe("PollService calendar", () => {
  it("notifies an event starting within 3 hours as urgent, once", async () => {
    await poll.pollOnce();
    calendar.listBetween.mockResolvedValue([event()]);
    expect(await poll.pollOnce()).toMatchObject({ events: 1 });
    expect(await poll.pollOnce()).toMatchObject({ events: 0 });
    expect(notified()).toEqual([
      { dedupeKey: "cal:e1:2026-11-20T17:00:00.000Z:", priority: "urgent", text: "Board call starts in 2h 0m" },
    ]);
  });

  it("notifies again when the start time changes, saying it moved", async () => {
    await poll.pollOnce();
    calendar.listBetween.mockResolvedValue([event()]);
    await poll.pollOnce();
    calendar.listBetween.mockResolvedValue([event({ start: new Date("2026-11-20T16:30:00Z"), end: new Date("2026-11-20T17:30:00Z") })]);
    await poll.pollOnce();
    const keys = new Set(notified().filter((n) => n.dedupeKey.startsWith("cal:")).map((n) => n.dedupeKey));
    expect(keys.size).toBe(2);
    expect(notified().at(-1)!.text).toBe("Board call moved: now starts in 1h 30m");
  });

  it("stays quiet about events that are not close", async () => {
    await poll.pollOnce();
    calendar.listBetween.mockResolvedValue([event({ start: new Date("2026-11-20T22:00:00Z") })]);
    await poll.pollOnce();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("PollService failures", () => {
  it("tells the owner once a day to reconnect Google, and does not retry", async () => {
    gmail.currentHistoryId.mockRejectedValue(new GoogleAuthError());
    await expect(poll.pollOnce()).resolves.toEqual({ mail: 0, events: 0 });
    await poll.pollOnce();
    expect(notified()).toEqual([
      { dedupeKey: "google-auth:2026-11-20", priority: "urgent", text: expect.stringContaining("npm run google-auth") },
      { dedupeKey: "google-auth:2026-11-20", priority: "urgent", text: expect.stringContaining("npm run google-auth") },
    ]); // same key both times: the notifier delivers it once
  });

  it("lets a Google outage (5xx) propagate so the job queue retries it", async () => {
    gmail.currentHistoryId.mockRejectedValue(new GoogleApiError("down", 503));
    await expect(poll.pollOnce()).rejects.toBeInstanceOf(GoogleApiError);
  });
});
