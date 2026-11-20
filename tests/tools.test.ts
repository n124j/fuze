import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalRequiredError, ToolRegistry, registerMemoryTools, type Tool } from "../src/agent/tools.js";
import { MemoryStore } from "../src/memory/store.js";

let dir: string;
let mem: MemoryStore;
let reg: ToolRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fuse-tools-"));
  mem = new MemoryStore(dir, "America/New_York");
  reg = new ToolRegistry();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tool = (over: Partial<Tool> = {}): Tool => ({
  name: "demo",
  description: "demo tool",
  inputSchema: { type: "object" },
  needsApproval: false,
  run: async () => "ran",
  ...over,
});

describe("ToolRegistry", () => {
  it("returns an error string, not a throw, for an unknown tool", async () => {
    expect(await reg.execute("nope", {}, { approved: false })).toMatch(/unknown tool/i);
  });

  it("refuses a needsApproval tool without approval and never runs it", async () => {
    const run = vi.fn(async () => "sent");
    reg.register(tool({ name: "send_email", needsApproval: true, run }));
    await expect(reg.execute("send_email", {}, { approved: false })).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a needsApproval tool once approved", async () => {
    reg.register(tool({ name: "send_email", needsApproval: true, run: async () => "sent" }));
    expect(await reg.execute("send_email", {}, { approved: true })).toBe("sent");
  });

  it("turns a failure inside a tool into an error string the model can read", async () => {
    reg.register(
      tool({
        run: async () => {
          throw new Error("disk full");
        },
      }),
    );
    expect(await reg.execute("demo", {}, { approved: false })).toBe("Error: disk full");
  });

  it("lists tool specs in the shape the API expects", () => {
    reg.register(tool());
    expect(reg.specs()).toEqual([
      { name: "demo", description: "demo tool", input_schema: { type: "object" } },
    ]);
  });

  it("rejects registering two tools with the same name", () => {
    reg.register(tool());
    expect(() => reg.register(tool())).toThrow(/already registered/);
  });
});

describe("memory tools", () => {
  beforeEach(() => registerMemoryTools(reg, mem));

  it("registers the three memory tools, none needing approval", () => {
    expect(reg.specs().map((s) => s.name).sort()).toEqual([
      "memory_note",
      "memory_remember",
      "memory_set_preference",
    ]);
  });

  it("memory_set_preference updates the profile", async () => {
    await reg.execute("memory_set_preference", { key: "meetings", value: "afternoon" }, { approved: false });
    await reg.execute("memory_set_preference", { key: "Meetings", value: "morning" }, { approved: false });
    expect(mem.readProfile().split("\n").filter(Boolean)).toEqual(["- Meetings: morning"]);
  });

  it("memory_remember appends a long-term fact", async () => {
    await reg.execute("memory_remember", { fact: "Launch budget is 20k" }, { approved: false });
    expect(mem.readLongTerm()).toContain("Launch budget is 20k");
  });

  it("memory_note appends to today's daily file", async () => {
    await reg.execute("memory_note", { note: "asked about the client" }, { approved: false });
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    expect(mem.readDaily(today)).toContain("asked about the client");
  });

  it("returns an error string for invalid input instead of throwing", async () => {
    expect(await reg.execute("memory_set_preference", {}, { approved: false })).toMatch(/^Error/);
    expect(await reg.execute("memory_remember", { fact: 42 }, { approved: false })).toMatch(/^Error/);
    expect(mem.readProfile()).toBe("");
  });
});
