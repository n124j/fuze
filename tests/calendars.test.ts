import { describe, expect, it, vi } from "vitest";
import { mergeCalendars } from "../src/calendars.js";
import type { CalEvent } from "../src/google/calendar.js";

const ev = (id: string, title: string, start: string, uid?: string): CalEvent => ({
  id,
  title,
  start: new Date(start),
  end: new Date(new Date(start).getTime() + 3_600_000),
  allDay: false,
  updated: new Date(0),
  uid,
});
const range: [Date, Date] = [new Date("2026-11-20T00:00:00Z"), new Date("2026-11-21T00:00:00Z")];
const primary = (events: CalEvent[]) => ({
  listBetween: vi.fn(async () => events),
  createEvent: vi.fn(async () => events[0]!),
});

describe("mergeCalendars", () => {
  it("collapses the same uid to the primary's event", async () => {
    const p = primary([ev("g1", "Sync", "2026-11-20T15:00:00Z", "u1")]);
    const merged = mergeCalendars(p, [{ name: "Apple", listBetween: async () => [ev("apple:u1", "Sync", "2026-11-20T15:00:00Z", "u1")] }], vi.fn());
    const out = await merged.listBetween(...range);
    expect(out.map((e) => e.id)).toEqual(["g1"]);
  });

  it("collapses events with no uid by lowercased title and start", async () => {
    const p = primary([ev("g1", "Dentist ", "2026-11-20T15:00:00Z")]);
    const merged = mergeCalendars(p, [{ name: "Apple", listBetween: async () => [ev("apple:x", "dentist", "2026-11-20T15:00:00Z")] }], vi.fn());
    expect(await merged.listBetween(...range)).toHaveLength(1);
  });

  it("keeps different events and sorts by start", async () => {
    const p = primary([ev("g1", "Late", "2026-11-20T18:00:00Z", "a")]);
    const merged = mergeCalendars(p, [{ name: "Apple", listBetween: async () => [ev("apple:b", "Early", "2026-11-20T09:00:00Z", "b")] }], vi.fn());
    expect((await merged.listBetween(...range)).map((e) => e.title)).toEqual(["Early", "Late"]);
  });

  it("still returns the primary's events when an extra fails, and reports it", async () => {
    const onError = vi.fn();
    const err = new Error("osascript timed out");
    const merged = mergeCalendars(primary([ev("g1", "Sync", "2026-11-20T15:00:00Z", "u1")]), [{ name: "Apple", listBetween: async () => { throw err; } }], onError);
    expect(await merged.listBetween(...range)).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith("Apple", err);
  });

  it("fails when the primary fails", async () => {
    const p = { listBetween: vi.fn(async () => { throw new Error("google down"); }), createEvent: vi.fn() };
    await expect(mergeCalendars(p, [], vi.fn()).listBetween(...range)).rejects.toThrow("google down");
  });

  it("creates events only on the primary", async () => {
    const p = primary([ev("g1", "Sync", "2026-11-20T15:00:00Z")]);
    const extra = { name: "Apple", listBetween: vi.fn(async () => []), createEvent: vi.fn() };
    const merged = mergeCalendars(p, [extra], vi.fn());
    await merged.createEvent({ title: "x", start: range[0], end: range[1] });
    expect(p.createEvent).toHaveBeenCalledTimes(1);
    expect(extra.createEvent).not.toHaveBeenCalled();
  });
});

describe("mergeCalendars: recurring events", () => {
  it("keeps every instance of a recurring Google series (same uid, different start)", async () => {
    const p = primary([ev("g1", "Standup", "2026-11-20T14:00:00Z", "series"), ev("g2", "Standup", "2026-11-21T14:00:00Z", "series")]);
    const merged = mergeCalendars(p, [], vi.fn());
    expect(await merged.listBetween(...range)).toHaveLength(2);
  });

  it("still removes the Apple copy of a specific instance", async () => {
    const p = primary([ev("g1", "Standup", "2026-11-20T14:00:00Z", "series")]);
    const merged = mergeCalendars(p, [{ name: "Apple", listBetween: async () => [ev("apple:series", "Standup", "2026-11-20T14:00:00Z", "series")] }], vi.fn());
    expect((await merged.listBetween(...range)).map((e) => e.id)).toEqual(["g1"]);
  });
});
