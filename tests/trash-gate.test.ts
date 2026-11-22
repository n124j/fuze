import { beforeEach, describe, expect, it, vi } from "vitest";
import { TrashGate } from "../src/approvals/trash-gate.js";
import { openDb, type Db } from "../src/db.js";

const T0 = new Date("2026-11-21T13:00:00Z");
const HOUR = 3_600_000;
const summary = (id: string) => ({ id, from: `Sender ${id} <s${id}@x.com>`, subject: `Subject ${id}`, date: new Date("2026-01-01T00:00:00Z"), unread: false });

let db: Db;
let now: Date;
let ids: string[];
let more: boolean;
let listIds: ReturnType<typeof vi.fn>;
let trash: ReturnType<typeof vi.fn>;
let ask: ReturnType<typeof vi.fn>;
let gate: TrashGate;

beforeEach(() => {
  db = openDb(":memory:");
  now = T0;
  ids = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
  more = false;
  listIds = vi.fn(async (_q: string, _max: number) => ({ ids: [...ids], more }));
  trash = vi.fn(async (_ids: string[]) => {});
  ask = vi.fn(async (_text: string, _id: string) => {});
  const gmail = { listIds, trash, summaries: async (list: string[]) => list.map(summary) };
  gate = new TrashGate(db, gmail as never, ask as never, () => now);
});

const status = (id: string) => (db.prepare("SELECT status FROM trash_requests WHERE id = ?").get(id) as { status: string }).status;

describe("TrashGate.request", () => {
  it("freezes the matching ids, asks the owner with a count and examples, and trashes nothing", async () => {
    const res = await gate.request("has:attachment older_than:1y");
    expect(res).toMatchObject({ count: 7 });
    expect(listIds).toHaveBeenCalledWith("has:attachment older_than:1y", 200);
    expect(trash).not.toHaveBeenCalled();
    const [text, approvalId] = ask.mock.calls[0]!;
    expect(approvalId).toBe(res!.id);
    expect(text).toContain("7 emails");
    expect(text).toContain("has:attachment older_than:1y");
    expect(text).toContain("Subject m1");
    expect(text).not.toContain("Subject m6"); // only a few examples
    expect(text).toContain("30 days");
    expect(status(res!.id)).toBe("pending");
  });

  it("says when more than the limit matched", async () => {
    more = true;
    await gate.request("older_than:5y");
    expect(ask.mock.calls[0]![0]).toContain("first 200");
  });

  it("returns null and asks nothing when no email matches", async () => {
    ids = [];
    expect(await gate.request("from:nobody")).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("TrashGate.decide", () => {
  it("trashes exactly the frozen ids on approval, without searching again", async () => {
    const { id } = (await gate.request("q"))!;
    ids = ["new1", "new2"]; // the mailbox changes afterwards
    const res = await gate.decide(id, "approve");
    expect(res).toEqual({ decision: "trashed", count: 7 });
    expect(trash).toHaveBeenCalledWith(["m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
    expect(listIds).toHaveBeenCalledTimes(1);
    expect(status(id)).toBe("trashed");
  });

  it("does nothing on a second tap", async () => {
    const { id } = (await gate.request("q"))!;
    await gate.decide(id, "approve");
    expect((await gate.decide(id, "approve")).decision).toBe("already-decided");
    expect(trash).toHaveBeenCalledTimes(1);
  });

  it("two taps at once trash only once", async () => {
    const { id } = (await gate.request("q"))!;
    const [a, b] = await Promise.all([gate.decide(id, "approve"), gate.decide(id, "approve")]);
    expect([a.decision, b.decision].sort()).toEqual(["already-decided", "trashed"]);
    expect(trash).toHaveBeenCalledTimes(1);
  });

  it("rejecting trashes nothing", async () => {
    const { id } = (await gate.request("q"))!;
    expect((await gate.decide(id, "reject")).decision).toBe("rejected");
    expect(trash).not.toHaveBeenCalled();
    expect((await gate.decide(id, "approve")).decision).toBe("already-decided");
  });

  it("expires after 24 hours", async () => {
    const { id } = (await gate.request("q"))!;
    now = new Date(T0.getTime() + 25 * HOUR);
    expect((await gate.decide(id, "approve")).decision).toBe("expired");
    expect(trash).not.toHaveBeenCalled();
  });

  it("does not know an invented id", async () => {
    expect((await gate.decide("nope", "approve")).decision).toBe("unknown-id");
  });

  it("lets the owner tap again after Gmail refuses, since nothing was trashed", async () => {
    const { id } = (await gate.request("q"))!;
    trash.mockRejectedValueOnce(new Error("gmail down"));
    await expect(gate.decide(id, "approve")).rejects.toThrow("gmail down");
    expect(status(id)).toBe("pending");
    expect((await gate.decide(id, "approve")).decision).toBe("trashed");
  });
});

describe("TrashGate.pending", () => {
  it("lists requests still waiting, and drops decided or expired ones", async () => {
    const a = (await gate.request("older_than:1y"))!;
    const b = (await gate.request("has:attachment"))!;
    await gate.decide(b.id, "reject");
    expect(gate.pending()).toEqual([{ id: a.id, summary: "Move 7 emails to Trash (search: older_than:1y)" }]);
    now = new Date(T0.getTime() + 25 * HOUR);
    expect(gate.pending()).toEqual([]);
  });
});

describe("TrashGate follow-up rounds", () => {
  const full = () => Array.from({ length: 200 }, (_, i) => `m${i}`);

  it("asks about the next batch right after a full batch is trashed", async () => {
    ids = full();
    const first = (await gate.request("older_than:5y"))!;
    ids = Array.from({ length: 30 }, (_, i) => `n${i}`); // what is left afterwards
    const res = await gate.decide(first.id, "approve");
    expect(res.decision).toBe("trashed");
    expect(res.next).toMatchObject({ count: 30 });
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1]![0]).toContain("Move 30 emails");
    expect(trash).toHaveBeenCalledTimes(1); // the next batch still waits for its own approval
    expect(status(res.next!.id)).toBe("pending");
  });

  it("does not ask again when nothing is left", async () => {
    ids = full();
    const first = (await gate.request("older_than:5y"))!;
    ids = [];
    const res = await gate.decide(first.id, "approve");
    expect(res.next).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does not look for more after a short batch, or after a rejection", async () => {
    const small = (await gate.request("q"))!;
    await gate.decide(small.id, "approve");
    ids = full();
    const big = (await gate.request("q2"))!;
    await gate.decide(big.id, "reject");
    expect(listIds).toHaveBeenCalledTimes(2);
  });

  it("still reports the trashing as done when the follow-up question cannot be sent", async () => {
    ids = full();
    const first = (await gate.request("older_than:5y"))!;
    ids = ["n1"];
    ask.mockRejectedValueOnce(new Error("telegram down"));
    const res = await gate.decide(first.id, "approve");
    expect(res.decision).toBe("trashed");
    expect(res.next).toBeNull();
  });
});
