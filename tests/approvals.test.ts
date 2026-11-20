import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate, draftHash } from "../src/approvals/gate.js";
import { openDb, type Db } from "../src/db.js";
import { GoogleApiError } from "../src/google/auth.js";
import type { DraftContent } from "../src/google/gmail.js";

const T0 = new Date("2026-11-20T13:00:00Z");
const HOUR = 3_600_000;

let db: Db;
let now: Date;
let draft: DraftContent;
let sendDraft: ReturnType<typeof vi.fn>;
let ask: ReturnType<typeof vi.fn>;
let gate: ApprovalGate;

beforeEach(() => {
  db = openDb(":memory:");
  now = T0;
  draft = { to: ["Ann@Example.com"], cc: [], subject: "Lunch", body: "SECRET BODY: see you at noon" };
  sendDraft = vi.fn(async () => ({ messageId: "m-1" }));
  ask = vi.fn(async () => {});
  gate = new ApprovalGate(db, { getDraft: async () => structuredClone(draft), sendDraft } as never, ask as never, () => now);
});

const status = (id: string) => (db.prepare("SELECT status FROM approvals WHERE id = ?").get(id) as { status: string }).status;

describe("draftHash", () => {
  it("ignores recipient order and case, but not content", () => {
    const a = draftHash({ to: ["b@x.com", "A@x.com"], cc: [], subject: "s", body: "b" });
    expect(draftHash({ to: ["a@x.com", "B@x.com"], cc: [], subject: "s", body: "b" })).toBe(a);
    expect(draftHash({ to: ["a@x.com", "b@x.com"], cc: [], subject: "s", body: "b2" })).not.toBe(a);
    expect(draftHash({ to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], subject: "s", body: "b" })).not.toBe(a);
    expect(draftHash({ to: ["a@x.com", "b@x.com"], cc: [], subject: "s2", body: "b" })).not.toBe(a);
  });
});

describe("ApprovalGate.request", () => {
  it("shows the owner the start of the body, cut at 500 characters", async () => {
    draft.body = "x".repeat(900);
    await gate.request("d1");
    const text = ask.mock.calls[0]![0] as string;
    expect(text).toContain("x".repeat(500));
    expect(text).not.toContain("x".repeat(501));
  });

  it("asks the owner with recipients, subject and a body excerpt", async () => {
    const id = await gate.request("d1");
    expect(ask).toHaveBeenCalledTimes(1);
    const [text, approvalId] = ask.mock.calls[0]!;
    expect(approvalId).toBe(id);
    expect(text).toContain("Ann@Example.com");
    expect(text).toContain("Lunch");
    expect(text).toContain("SECRET BODY: see you at noon");
    expect(gate.pending()).toEqual([{ id, summary: expect.stringContaining("Lunch") }]);
  });
});

describe("ApprovalGate.decide", () => {
  it("sends an unchanged draft exactly once on approval", async () => {
    const id = await gate.request("d1");
    expect(await gate.decide(id, "approve")).toBe("sent");
    expect(sendDraft).toHaveBeenCalledTimes(1);
    expect(sendDraft).toHaveBeenCalledWith("d1");
    expect(status(id)).toBe("sent");
    expect(gate.pending()).toEqual([]);
  });

  it("voids the approval if the body was edited after the request", async () => {
    const id = await gate.request("d1");
    draft.body = "Totally different text";
    expect(await gate.decide(id, "approve")).toBe("changed");
    expect(sendDraft).not.toHaveBeenCalled();
    expect(status(id)).toBe("void");
  });

  it("voids the approval if a recipient was added", async () => {
    const id = await gate.request("d1");
    draft.cc = ["boss@corp.com"];
    expect(await gate.decide(id, "approve")).toBe("changed");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("ignores a second tap", async () => {
    const id = await gate.request("d1");
    await gate.decide(id, "approve");
    expect(await gate.decide(id, "approve")).toBe("already-decided");
    expect(sendDraft).toHaveBeenCalledTimes(1);
  });

  it("expires after 24 hours", async () => {
    const id = await gate.request("d1");
    now = new Date(T0.getTime() + 24 * HOUR + 1000);
    expect(await gate.decide(id, "approve")).toBe("expired");
    expect(sendDraft).not.toHaveBeenCalled();
    expect(gate.pending()).toEqual([]);
  });

  it("still allows approval just inside 24 hours", async () => {
    const id = await gate.request("d1");
    now = new Date(T0.getTime() + 24 * HOUR - 1000);
    expect(await gate.decide(id, "approve")).toBe("sent");
  });

  it("rejects, and a later approve does nothing", async () => {
    const id = await gate.request("d1");
    expect(await gate.decide(id, "reject")).toBe("rejected");
    expect(await gate.decide(id, "approve")).toBe("already-decided");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("reports an unknown id", async () => {
    expect(await gate.decide("nope", "approve")).toBe("unknown-id");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("keeps the request open for a retry when Gmail clearly refused it (4xx)", async () => {
    sendDraft.mockRejectedValueOnce(new GoogleApiError("bad request", 400));
    const id = await gate.request("d1");
    await expect(gate.decide(id, "approve")).rejects.toThrow("bad request");
    expect(status(id)).toBe("pending");
    expect(await gate.decide(id, "approve")).toBe("sent");
    expect(sendDraft).toHaveBeenCalledTimes(2);
  });

  it("does not claim a failure when the answer was lost: 5xx, network or unknown errors are unconfirmed", async () => {
    for (const err of [new GoogleApiError("busy", 503), new GoogleApiError("reset", 0), new Error("who knows")]) {
      sendDraft.mockClear();
      sendDraft.mockRejectedValueOnce(err);
      const id = await gate.request("d1");
      expect(await gate.decide(id, "approve")).toBe("send-unconfirmed");
      expect(status(id)).toBe("unconfirmed");
      expect(await gate.decide(id, "approve")).toBe("send-unconfirmed");
      expect(sendDraft).toHaveBeenCalledTimes(1);
      expect(gate.pending()).toEqual([]);
    }
  });

  it("treats a draft that was deleted in Gmail as changed, not as an error", async () => {
    const id = await gate.request("d1");
    gate = new ApprovalGate(db, { getDraft: async () => { throw new GoogleApiError("gone", 404); }, sendDraft } as never, ask as never, () => now);
    expect(await gate.decide(id, "approve")).toBe("changed");
    expect(sendDraft).not.toHaveBeenCalled();
    expect(status(id)).toBe("void");
  });

  it("never sends again when an earlier send was started but not recorded", async () => {
    const id = await gate.request("d1");
    // A previous process claimed the send, then died before recording it.
    db.prepare("INSERT INTO idempotency(key, status, created_at) VALUES (?, 'started', 1)").run(`send:${id}`);
    expect(await gate.decide(id, "approve")).toBe("send-unconfirmed");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("treats a request left mid-send by a dead process as unconfirmed", async () => {
    const id = await gate.request("d1");
    db.prepare("UPDATE approvals SET status = 'sending' WHERE id = ?").run(id);
    expect(await gate.decide(id, "approve")).toBe("send-unconfirmed");
    expect(sendDraft).not.toHaveBeenCalled();
  });
});
