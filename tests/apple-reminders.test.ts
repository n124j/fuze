import { describe, expect, it, vi } from "vitest";
import { AppleUnavailableError } from "../src/apple/osascript.js";
import { RemindersClient } from "../src/apple/reminders.js";
import { registerAppleTools } from "../src/apple/tools.js";
import { ToolRegistry } from "../src/agent/tools.js";
import { openDb } from "../src/db.js";

const NOW = Date.parse("2026-11-20T15:00:00Z");

describe("RemindersClient", () => {
  it("lists open reminders", async () => {
    const run = vi.fn(async (_s: string, _p: unknown) =>
      JSON.stringify([
        { id: "R1", title: "Call mum", due: "2026-11-21T15:00:00.000Z", list: "Home" },
        { id: "R2", title: "Buy milk", due: null, list: "Home" },
      ]),
    );
    const items = await new RemindersClient(run, openDb(":memory:"), () => NOW).listOpen();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "apple:R1", title: "Call mum", done: false });
    expect(items[0]!.due!.toISOString()).toBe("2026-11-21T15:00:00.000Z");
    expect(items[1]!.due).toBeUndefined();
  });

  it("creates a reminder once per hour for the same title and due", async () => {
    let clock = NOW;
    const run = vi.fn(async (_s: string, _p: unknown) => JSON.stringify({ id: "N1" }));
    const client = new RemindersClient(run, openDb(":memory:"), () => clock);
    const due = new Date("2026-11-22T10:00:00Z");
    const a = await client.create("Pay rent", due);
    const b = await client.create("Pay rent", due);
    expect(a.id).toBe("apple:N1");
    expect(b.id).toBe("apple:N1");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toEqual({ title: "Pay rent", due: due.toISOString() });
    clock += 2 * 3_600_000;
    await client.create("Pay rent", due);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("passes hostile titles only as data, never in the script", async () => {
    const run = vi.fn(async (_s: string, _p: unknown) => JSON.stringify({ id: "N" }));
    const client = new RemindersClient(run, openDb(":memory:"), () => NOW);
    await client.create("harmless");
    await client.create('x"); do shell script "rm -rf ~"; ("\n`whoami`');
    const [s1] = run.mock.calls[0]!;
    const [s2, payload] = run.mock.calls[1]!;
    expect(s2).toBe(s1);
    expect((payload as { title: string }).title).toContain("rm -rf");
    expect(s2).not.toContain("rm -rf");
  });
});

describe("apple tools", () => {
  const setup = (reminders: Parameters<typeof registerAppleTools>[1]["reminders"]) => {
    const reg = new ToolRegistry();
    registerAppleTools(reg, { reminders, tz: "America/New_York" });
    return reg;
  };
  const ctx = { approved: false };

  it("creates and lists reminders", async () => {
    const reminders = {
      create: vi.fn(async (title: string, due?: Date) => ({ id: "apple:N1", title, due, done: false })),
      listOpen: vi.fn(async () => [{ id: "apple:R1", title: "Call mum", due: new Date("2026-11-21T15:00:00Z"), done: false }]),
    };
    const reg = setup(reminders);
    const made = await reg.execute("reminders_create", { title: "Pay rent", due: "2026-11-22T10:00:00Z" }, ctx);
    expect(made).toContain("Pay rent");
    expect(reminders.create).toHaveBeenCalledWith("Pay rent", new Date("2026-11-22T10:00:00Z"));
    const listed = await reg.execute("reminders_list", {}, ctx);
    expect(listed).toContain("Call mum");
    expect(listed).toContain("2026-11-21 10:00");
  });

  it("reports unavailability as an error string", async () => {
    const reminders = {
      create: vi.fn(),
      listOpen: vi.fn(async () => {
        throw new AppleUnavailableError();
      }),
    };
    expect(await setup(reminders).execute("reminders_list", {}, ctx)).toMatch(/^Error: .*macOS/);
  });
});
