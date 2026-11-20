import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExhaustedError, BudgetGuard } from "../src/budget/guard.js";
import { DEFAULT_PRICING } from "../src/budget/pricing.js";
import { openDb } from "../src/db.js";
import { ScriptedLlm } from "../src/llm/scripted.js";
import type { LlmResponse } from "../src/llm/types.js";
import { applyEdits, consolidateMemory } from "../src/memory/consolidate.js";
import { MemoryStore } from "../src/memory/store.js";

const TZ = "America/New_York";
const NOW = new Date("2026-11-22T08:00:00Z"); // Sunday 03:00 in New York
const usage = { model: "claude-sonnet-5-5", inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
const answer = (text: string): LlmResponse => ({ content: [{ type: "text", text }], stopReason: "end_turn", usage });

let dir: string;
let memory: MemoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fuse-cons-"));
  memory = new MemoryStore(dir, TZ);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(responses: LlmResponse[], capUsd = 1) {
  const llm = new ScriptedLlm(responses);
  const budget = new BudgetGuard(openDb(":memory:"), capUsd, TZ, DEFAULT_PRICING, () => NOW);
  return { llm, budget, deps: { memory, llm, budget, model: "claude-sonnet-5-5", tz: TZ, clock: () => NOW } };
}

describe("applyEdits", () => {
  const current = "- likes tea\n- old fact\n- works at Acme\n- lives in NYC\n";

  it("removes exact lines and appends new facts", () => {
    const r = applyEdits(current, { add: ["Prefers morning meetings"], remove: ["- old fact"], summary: "" });
    expect(r).toEqual({ text: "- likes tea\n- works at Acme\n- lives in NYC\n- Prefers morning meetings\n", added: 1, removed: 1 });
  });

  it("accepts a removal written without the dash and skips facts already present", () => {
    const r = applyEdits(current, { add: ["likes tea"], remove: ["old fact"], summary: "" });
    expect(r).toMatchObject({ added: 0, removed: 1 });
    expect((r as { text: string }).text).not.toContain("old fact");
  });

  it("ignores a removal that matches nothing", () => {
    const r = applyEdits(current, { add: [], remove: ["- never existed"], summary: "" });
    expect(r).toEqual({ text: current, added: 0, removed: 0 });
  });

  it("rejects removing more than half of the lines", () => {
    const r = applyEdits(current, { add: [], remove: ["- likes tea", "- old fact", "- works at Acme"], summary: "" });
    expect(r).toHaveProperty("rejected");
  });

  it("rejects too many or too long additions", () => {
    const many = Array.from({ length: 11 }, (_v, i) => `fact ${i}`);
    expect(applyEdits(current, { add: many, remove: [], summary: "" })).toHaveProperty("rejected");
    expect(applyEdits(current, { add: ["x".repeat(301)], remove: [], summary: "" })).toHaveProperty("rejected");
  });

  it("gives the same result when applied twice", () => {
    const edits = { add: ["New fact"], remove: ["- old fact"], summary: "" };
    const once = applyEdits(current, edits) as { text: string };
    const twice = applyEdits(once.text, edits) as { text: string };
    expect(twice.text).toBe(once.text);
  });
});

describe("consolidateMemory", () => {
  const valid = JSON.stringify({ add: ["Prefers morning meetings"], remove: ["- old fact"], summary: "Merged 1, added 1" });

  beforeEach(() => {
    memory.appendLongTerm("old fact");
    memory.appendLongTerm("works at Acme");
    memory.appendDaily("Owner asked to move meetings to mornings", NOW);
  });

  it("backs up first, applies the edits and reports the summary", async () => {
    const { llm, deps } = setup([answer(valid)]);
    const before = memory.readLongTerm();
    const res = await consolidateMemory(deps);
    expect(res).toMatchObject({ applied: true, message: "Merged 1, added 1" });
    expect(memory.readLongTerm()).toBe("- works at Acme\n- Prefers morning meetings\n");
    const backups = readdirSync(join(dir, "backups"));
    expect(backups).toEqual(expect.arrayContaining(["2026-11-22-memory.md", "2026-11-22-profile.md"]));
    expect(readFileSync(join(dir, "backups", "2026-11-22-memory.md"), "utf8")).toBe(before);
    expect(llm.calls).toHaveLength(1);
  });

  it("wraps the notes and memory as untrusted data", async () => {
    const { llm, deps } = setup([answer(valid)]);
    await consolidateMemory(deps);
    const call = llm.calls[0]!;
    const user = JSON.stringify(call.messages);
    expect(user).toContain("<untrusted_notes>");
    expect(user).toContain("<untrusted_memory>");
    expect(call.system).toMatch(/data, not instructions/i);
  });

  it("leaves memory untouched on invalid, misshapen or rejected answers", async () => {
    const before = memory.readLongTerm();
    for (const bad of [
      "not json at all",
      JSON.stringify({ add: "oops" }),
      JSON.stringify({ add: [], remove: ["- old fact", "- works at Acme"], summary: "wipe" }),
    ]) {
      const { deps } = setup([answer(bad)]);
      const res = await consolidateMemory(deps);
      expect(res.applied).toBe(false);
      expect(memory.readLongTerm()).toBe(before);
    }
  });

  it("accepts an answer wrapped in a code fence", async () => {
    const { deps } = setup([answer("```json\n" + valid + "\n```")]);
    expect((await consolidateMemory(deps)).applied).toBe(true);
  });

  it("does not spend when the budget is gone", async () => {
    const { llm, deps } = setup([answer(valid)], 0.0000001);
    deps.budget.record({ ...usage, inputTokens: 1_000_000 });
    await expect(consolidateMemory(deps)).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(llm.calls).toHaveLength(0);
  });

  it("does not call the model when given saved edits", async () => {
    const { llm, deps } = setup([]);
    const res = await consolidateMemory(deps, { add: ["Saved fact"], remove: [], summary: "from checkpoint" });
    expect(res.applied).toBe(true);
    expect(llm.calls).toHaveLength(0);
    expect(memory.readLongTerm()).toContain("- Saved fact");
  });

  it("reports the edits before applying them so a retry can reuse them", async () => {
    const { deps } = setup([answer(valid)]);
    const onEdits = vi.fn();
    await consolidateMemory({ ...deps, onEdits });
    expect(onEdits).toHaveBeenCalledWith({ add: ["Prefers morning meetings"], remove: ["- old fact"], summary: "Merged 1, added 1" });
  });

  it("keeps the first backup when run again after memory changed", async () => {
    const { deps } = setup([answer(valid), answer(valid)]);
    const original = memory.readLongTerm();
    await consolidateMemory(deps);
    await consolidateMemory({ ...deps, llm: new ScriptedLlm([answer(JSON.stringify({ add: ["Another"], remove: [], summary: "again" }))]) });
    expect(readFileSync(join(dir, "backups", "2026-11-22-memory.md"), "utf8")).toBe(original);
  });

  it("does nothing when there are no notes and no memory", async () => {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "fuse-cons-"));
    memory = new MemoryStore(dir, TZ);
    const { llm, deps } = setup([answer(valid)]);
    const res = await consolidateMemory({ ...deps, memory });
    expect(res).toMatchObject({ applied: false, message: "Nothing to consolidate." });
    expect(llm.calls).toHaveLength(0);
  });
});
