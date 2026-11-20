import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { Notifier } from "../src/notify/notifier.js";

const cfg = { timezone: "America/New_York", quietStart: "23:00", quietEnd: "07:00" };
const NIGHT = new Date("2026-11-20T08:00:00Z"); // 03:00 in New York
const DAY = new Date("2026-11-20T18:00:00Z"); // 13:00 in New York

let now: Date;
let send: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let notifier: Notifier;

beforeEach(() => {
  now = DAY;
  send = vi.fn(async () => {});
  notifier = new Notifier(openDb(":memory:"), send, cfg, () => now);
});

describe("Notifier priorities", () => {
  it("sends an urgent notification immediately, even at night", async () => {
    now = NIGHT;
    expect(await notifier.notify({ dedupeKey: "a", priority: "urgent", text: "client needs you" })).toBe("sent");
    expect(send).toHaveBeenCalledWith("client needs you");
  });

  it("sends a normal notification right away during the day", async () => {
    expect(await notifier.notify({ dedupeKey: "a", priority: "normal", text: "meeting moved" })).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holds a normal notification during quiet hours", async () => {
    now = NIGHT;
    expect(await notifier.notify({ dedupeKey: "a", priority: "normal", text: "meeting moved" })).toBe("deferred");
    expect(send).not.toHaveBeenCalled();
  });

  it("saves a low-priority notification for the briefing and never sends it alone", async () => {
    expect(await notifier.notify({ dedupeKey: "a", priority: "low", text: "newsletter" })).toBe("digest");
    expect(send).not.toHaveBeenCalled();
    expect(notifier.takeDigest()).toEqual(["newsletter"]);
    expect(notifier.takeDigest()).toEqual([]);
  });
});

describe("Notifier duplicates", () => {
  it("never sends the same item twice", async () => {
    await notifier.notify({ dedupeKey: "a", priority: "normal", text: "x" });
    expect(await notifier.notify({ dedupeKey: "a", priority: "normal", text: "x" })).toBe("duplicate");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats an item that was deferred as already seen", async () => {
    now = NIGHT;
    await notifier.notify({ dedupeKey: "a", priority: "normal", text: "x" });
    now = DAY;
    expect(await notifier.notify({ dedupeKey: "a", priority: "normal", text: "x" })).toBe("duplicate");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not let an item through again as a different priority", async () => {
    await notifier.notify({ dedupeKey: "a", priority: "low", text: "x" });
    expect(await notifier.notify({ dedupeKey: "a", priority: "urgent", text: "x" })).toBe("duplicate");
  });
});

describe("Notifier.flushDeferred", () => {
  it("sends everything held overnight as one message", async () => {
    now = NIGHT;
    for (const k of ["a", "b", "c"]) await notifier.notify({ dedupeKey: k, priority: "normal", text: `item ${k}` });
    now = DAY;
    expect(await notifier.flushDeferred()).toBe(3);
    expect(send).toHaveBeenCalledTimes(1);
    const text = send.mock.calls[0]![0];
    for (const k of ["a", "b", "c"]) expect(text).toContain(`item ${k}`);
    expect(await notifier.flushDeferred()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does nothing while it is still quiet hours", async () => {
    now = NIGHT;
    await notifier.notify({ dedupeKey: "a", priority: "normal", text: "x" });
    expect(await notifier.flushDeferred()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    now = DAY;
    expect(await notifier.flushDeferred()).toBe(1);
  });

  it("keeps the items if delivery fails so they can be sent next time", async () => {
    now = NIGHT;
    await notifier.notify({ dedupeKey: "a", priority: "normal", text: "x" });
    now = DAY;
    send.mockRejectedValueOnce(new Error("telegram is down"));
    await expect(notifier.flushDeferred()).rejects.toThrow("telegram is down");
    expect(await notifier.flushDeferred()).toBe(1);
  });
});

describe("Notifier delivery failures", () => {
  it("lets the same item be tried again when sending failed", async () => {
    send.mockRejectedValueOnce(new Error("telegram is down"));
    await expect(notifier.notify({ dedupeKey: "a", priority: "urgent", text: "x" })).rejects.toThrow("telegram is down");
    expect(await notifier.notify({ dedupeKey: "a", priority: "urgent", text: "x" })).toBe("sent");
  });
});
