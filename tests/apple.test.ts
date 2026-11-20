import { describe, expect, it, vi } from "vitest";
import { AppleCalendarClient } from "../src/apple/calendar.js";
import { AppleUnavailableError, checkAppleAccess, createOsascriptRunner, type ScriptRunner } from "../src/apple/osascript.js";

type Cb = (err: (Error & { stderr?: string }) | null, stdout: string, stderr: string) => void;

describe("createOsascriptRunner", () => {
  it("refuses to run off macOS", async () => {
    const run = createOsascriptRunner({ platform: "win32" });
    await expect(run("x", {})).rejects.toBeInstanceOf(AppleUnavailableError);
    await expect(run("x", {})).rejects.toThrow("only available on macOS");
  });

  it("runs osascript with the payload as a JSON argument and returns stdout", async () => {
    const exec = vi.fn((_f: string, _a: string[], _o: object, cb: Cb) => cb(null, "[1]", ""));
    const run = createOsascriptRunner({ platform: "darwin", execFile: exec, timeoutMs: 1234 });
    expect(await run("SCRIPT", { a: 1 })).toBe("[1]");
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("osascript");
    expect(args).toEqual(["-l", "JavaScript", "-e", "SCRIPT", '{"a":1}']);
    expect((opts as { timeout: number }).timeout).toBe(1234);
  });

  it("surfaces stderr when the script fails", async () => {
    const exec = vi.fn((_f: string, _a: string[], _o: object, cb: Cb) =>
      cb(Object.assign(new Error("Command failed"), { stderr: "  not authorized  " }), "", "  not authorized  "),
    );
    const run = createOsascriptRunner({ platform: "darwin", execFile: exec });
    await expect(run("S", {})).rejects.toThrow("not authorized");
  });
});

describe("checkAppleAccess", () => {
  it("returns null when scripting works", async () => {
    expect(await checkAppleAccess(async () => "3")).toBeNull();
  });
  it("explains when Apple apps are unavailable", async () => {
    const run: ScriptRunner = async () => {
      throw new AppleUnavailableError("Apple apps are only available on macOS");
    };
    expect(await checkAppleAccess(run)).toContain("only available on macOS");
  });
  it("points at the Automation permission for other failures", async () => {
    const run: ScriptRunner = async () => {
      throw new Error("not authorized");
    };
    expect(await checkAppleAccess(run)).toContain("Automation");
  });
});

describe("AppleCalendarClient", () => {
  const from = new Date("2026-11-21T00:00:00Z");
  const to = new Date("2026-11-22T00:00:00Z");

  it("maps events and sends the range as ISO strings", async () => {
    const run = vi.fn(async (_s: string, _p: unknown) =>
      JSON.stringify([{ uid: "U1", title: "Standup", start: "2026-11-21T14:00:00.000Z", end: "2026-11-21T14:15:00.000Z", allDay: false, location: "Room 2" }]),
    );
    const events = await new AppleCalendarClient(run).listBetween(from, to);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "apple:U1", uid: "U1", title: "Standup", allDay: false, location: "Room 2" });
    expect(events[0]!.start.toISOString()).toBe("2026-11-21T14:00:00.000Z");
    expect(run.mock.calls[0]![1]).toEqual({ from: from.toISOString(), to: to.toISOString() });
  });

  it("skips a malformed entry and keeps the rest", async () => {
    const run = async () =>
      JSON.stringify([
        { uid: "bad", title: "No start" },
        { uid: "ok", title: "Fine", start: "2026-11-21T10:00:00.000Z", end: "2026-11-21T11:00:00.000Z", allDay: false },
      ]);
    const events = await new AppleCalendarClient(run).listBetween(from, to);
    expect(events.map((e) => e.uid)).toEqual(["ok"]);
  });

  it("throws on output that is not JSON", async () => {
    await expect(new AppleCalendarClient(async () => "oops").listBetween(from, to)).rejects.toThrow();
  });
});
