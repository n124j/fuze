import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";

const TZ = "America/New_York";
let dir: string;
let mem: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fuse-mem-"));
  mem = new MemoryStore(dir, TZ);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MemoryStore", () => {
  it("creates the memory files on first use", () => {
    expect(existsSync(join(dir, "profile.md"))).toBe(true);
    expect(existsSync(join(dir, "memory.md"))).toBe(true);
    expect(existsSync(join(dir, "daily"))).toBe(true);
    expect(mem.readProfile()).toBe("");
  });

  it("updates an existing preference instead of duplicating it", () => {
    mem.setProfileEntry("meetings", "afternoon");
    mem.setProfileEntry("Meetings", "morning");
    const lines = mem.readProfile().split("\n").filter(Boolean);
    expect(lines).toEqual(["- Meetings: morning"]);
  });

  it("keeps different preferences on separate lines", () => {
    mem.setProfileEntry("meetings", "afternoon");
    mem.setProfileEntry("coffee", "black");
    expect(mem.readProfile().split("\n").filter(Boolean)).toEqual([
      "- meetings: afternoon",
      "- coffee: black",
    ]);
  });

  it("keeps a value on a single line even if it contains newlines", () => {
    mem.setProfileEntry("note", "line one\nline two");
    expect(mem.readProfile().split("\n").filter(Boolean)).toEqual(["- note: line one line two"]);
  });

  it("appends long-term facts", () => {
    mem.appendLongTerm("Launch budget is 20k");
    mem.appendLongTerm("Prefers Telegram");
    expect(mem.readLongTerm()).toContain("- Launch budget is 20k");
    expect(mem.readLongTerm()).toContain("- Prefers Telegram");
  });

  it("files daily notes under the local date, not the UTC date", () => {
    mem.appendDaily("asked about the client", new Date("2026-11-20T03:30:00Z")); // 22:30 on the 19th in New York
    expect(mem.readDaily("2026-11-19")).toContain("asked about the client");
    expect(mem.readDaily("2026-11-20")).toBe("");
  });

  it("leaves no temp files behind after writes", () => {
    mem.setProfileEntry("a", "b");
    mem.appendLongTerm("c");
    mem.appendDaily("d", new Date("2026-11-20T15:00:00Z"));
    const leftovers = [...readdirSync(dir), ...readdirSync(join(dir, "daily"))].filter((f) =>
      f.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("snapshotForPrompt", () => {
  const now = new Date("2026-11-20T15:00:00Z");

  it("includes the profile, long-term memory and today's notes under headings", () => {
    mem.setProfileEntry("meetings", "afternoon");
    mem.appendLongTerm("fact one");
    mem.appendDaily("did a thing", now);
    const s = mem.snapshotForPrompt(now);
    expect(s).toContain("- meetings: afternoon");
    expect(s).toContain("fact one");
    expect(s).toContain("did a thing");
  });

  it("stays within 8000 characters and keeps the newest notes when daily notes are huge", () => {
    mem.setProfileEntry("meetings", "afternoon");
    mem.appendDaily("OLDEST " + "x".repeat(50_000), now);
    mem.appendDaily("NEWEST", now);
    const s = mem.snapshotForPrompt(now);
    expect(s.length).toBeLessThanOrEqual(8000);
    expect(s).toContain("- meetings: afternoon");
    expect(s).toContain("NEWEST");
    expect(s).not.toContain("OLDEST");
  });

  it("never truncates the profile", () => {
    for (let i = 0; i < 400; i++) mem.setProfileEntry(`key${i}`, "v".repeat(30));
    const s = mem.snapshotForPrompt(now);
    expect(s).toContain("- key0:");
    expect(s).toContain("- key399:");
  });
});

describe("MemoryStore consolidation helpers", () => {
  const now = new Date("2026-11-22T15:00:00Z");

  it("recentDaily returns the last days oldest first and skips empty ones", () => {
    mem.appendDaily("today note", now);
    mem.appendDaily("three days ago", new Date(now.getTime() - 3 * 86_400_000));
    mem.appendDaily("too old", new Date(now.getTime() - 9 * 86_400_000));
    const days = mem.recentDaily(now, 7);
    expect(days.map((d) => d.date)).toEqual(["2026-11-19", "2026-11-22"]);
    expect(days[1]!.text).toContain("today note");
  });

  it("backupCore makes dated copies and never overwrites one", () => {
    mem.appendLongTerm("original");
    mem.setProfileEntry("tea", "green");
    const made = mem.backupCore("2026-11-22");
    expect(made).toHaveLength(2);
    expect(readFileSync(join(dir, "backups", "2026-11-22-memory.md"), "utf8")).toBe("- original\n");
    mem.appendLongTerm("changed later");
    expect(mem.backupCore("2026-11-22")).toEqual([]);
    expect(readFileSync(join(dir, "backups", "2026-11-22-memory.md"), "utf8")).toBe("- original\n");
  });

  it("writeLongTerm replaces the long-term file", () => {
    mem.appendLongTerm("old");
    mem.writeLongTerm("- new\n");
    expect(mem.readLongTerm()).toBe("- new\n");
  });
});
