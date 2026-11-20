import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent/loop.js";
import { ToolRegistry, registerMemoryTools } from "../src/agent/tools.js";
import { BudgetExhaustedError, BudgetGuard } from "../src/budget/guard.js";
import { openDb } from "../src/db.js";
import { ScriptedLlm } from "../src/llm/scripted.js";
import type { LlmResponse, Message, Pricing } from "../src/llm/types.js";
import { MemoryStore } from "../src/memory/store.js";

const TZ = "America/New_York";
const NOW = new Date("2026-11-20T15:00:00Z");
const pricing: Pricing = {
  cheap: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
  strong: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
};
const usage = (model = "cheap") => ({
  model,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}); // costs $0.002 with the table above

const text = (t: string, model = "cheap"): LlmResponse => ({
  content: [{ type: "text", text: t }],
  stopReason: "end_turn",
  usage: usage(model),
});
const toolUse = (id: string, name: string, input: unknown): LlmResponse => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
  usage: usage(),
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(responses: LlmResponse[], capUsd = 1) {
  const dir = mkdtempSync(join(tmpdir(), "fuse-agent-"));
  dirs.push(dir);
  const memory = new MemoryStore(dir, TZ);
  const budget = new BudgetGuard(openDb(":memory:"), capUsd, TZ, pricing, () => NOW);
  const tools = new ToolRegistry();
  registerMemoryTools(tools, memory);
  const llm = new ScriptedLlm(responses);
  return { llm, memory, budget, tools, deps: { llm, budget, tools, memory, models: { cheap: "cheap", strong: "strong" } } };
}

const input = (over: Partial<{ history: Message[]; userText: string; tier: "cheap" | "strong" }> = {}) => ({
  history: [],
  userText: "hello",
  tier: "cheap" as const,
  now: NOW,
  ...over,
});

describe("runAgent", () => {
  it("returns the model's text and records usage once", async () => {
    const s = setup([text("Hello there")]);
    const out = await runAgent(s.deps, input());
    expect(out.reply).toBe("Hello there");
    expect(s.budget.spentTodayUsd()).toBeCloseTo(0.002, 6);
    expect(s.llm.calls).toHaveLength(1);
  });

  it("runs a tool and sends its result back to the model", async () => {
    const s = setup([toolUse("t1", "memory_set_preference", { key: "meetings", value: "afternoon" }), text("Noted")]);
    const out = await runAgent(s.deps, input({ userText: "I prefer afternoon meetings" }));
    expect(out.reply).toBe("Noted");
    expect(s.llm.calls).toHaveLength(2);
    expect(s.memory.readProfile()).toContain("- meetings: afternoon");
    const last = s.llm.calls[1]!.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toMatchObject([{ type: "tool_result", tool_use_id: "t1" }]);
  });

  it("stops after 8 tool iterations instead of looping forever", async () => {
    const loop = Array.from({ length: 8 }, (_, i) => toolUse(`t${i}`, "memory_note", { note: "x" }));
    const s = setup(loop);
    const out = await runAgent(s.deps, input());
    expect(s.llm.calls).toHaveLength(8);
    expect(out.reply).toMatch(/stopped/i);
  });

  it("throws BudgetExhaustedError without calling the model when the cap is already reached", async () => {
    const s = setup([text("never")], 0.001);
    s.budget.record(usage()); // $0.002 > cap
    await expect(runAgent(s.deps, input())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(s.llm.calls).toHaveLength(0);
  });

  it("throws BudgetExhaustedError mid-conversation when a call uses up the cap", async () => {
    const s = setup([toolUse("t1", "memory_note", { note: "x" }), text("never reached")], 0.002);
    await expect(runAgent(s.deps, input())).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(s.llm.calls).toHaveLength(1);
  });

  it("puts the profile into the system prompt", async () => {
    const s = setup([text("ok")]);
    s.memory.setProfileEntry("meetings", "afternoon");
    await runAgent(s.deps, input());
    expect(s.llm.calls[0]!.system).toContain("- meetings: afternoon");
  });

  it("maps the tier to a model and a low effort for the cheap tier", async () => {
    const cheap = setup([text("a")]);
    await runAgent(cheap.deps, input({ tier: "cheap" }));
    expect(cheap.llm.calls[0]).toMatchObject({ model: "cheap", effort: "low" });
    const strong = setup([text("b", "strong")]);
    await runAgent(strong.deps, input({ tier: "strong" }));
    expect(strong.llm.calls[0]).toMatchObject({ model: "strong", effort: "medium" });
  });

  it("does not mutate the history it was given", async () => {
    const s = setup([text("ok")]);
    const history: Message[] = [{ role: "user", content: "earlier" }, { role: "assistant", content: "yes" }];
    const out = await runAgent(s.deps, input({ history }));
    expect(history).toHaveLength(2);
    expect(out.messages).toHaveLength(4);
    expect(s.llm.calls[0]!.messages[0]).toEqual({ role: "user", content: "earlier" });
  });

  it("never runs a tool that needs approval and tells the model so", async () => {
    const run = vi.fn(async () => "sent");
    const s = setup([toolUse("t1", "send_email", { to: "a@b.c" }), text("I need your approval first")]);
    s.tools.register({
      name: "send_email",
      description: "send",
      inputSchema: { type: "object" },
      needsApproval: true,
      run,
    });
    const out = await runAgent(s.deps, input());
    expect(run).not.toHaveBeenCalled();
    expect(out.reply).toBe("I need your approval first");
    const result = s.llm.calls[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>;
    expect(result[0]!.is_error).toBe(true);
    expect(result[0]!.content).toMatch(/approval/i);
  });

  it("gives a polite reply when the model refuses", async () => {
    const refused: LlmResponse = { content: [], stopReason: "refusal", usage: usage() };
    const out = await runAgent(setup([refused]).deps, input());
    expect(out.reply).toMatch(/can't help/i);
  });

  it("never returns an empty reply", async () => {
    const empty: LlmResponse = { content: [], stopReason: "end_turn", usage: usage() };
    const out = await runAgent(setup([empty]).deps, input());
    expect(out.reply.length).toBeGreaterThan(0);
  });
});
