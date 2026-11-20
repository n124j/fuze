import { describe, expect, it } from "vitest";
import { isQuietHours, localDateKey, nextLocalTime } from "../src/time.js";

const TZ = "America/New_York";
const quiet = (iso: string) => isQuietHours(new Date(iso), TZ, "23:00", "07:00");

describe("isQuietHours (23:00-07:00 America/New_York)", () => {
  it("is quiet late at night", () => expect(quiet("2026-11-20T04:30:00Z")).toBe(true)); // 23:30 EST
  it("ends exactly at 07:00", () => expect(quiet("2026-11-20T12:00:00Z")).toBe(false)); // 07:00 EST
  it("is quiet one minute before the end", () => expect(quiet("2026-11-20T11:59:00Z")).toBe(true)); // 06:59
  it("is not quiet in the afternoon", () => expect(quiet("2026-11-20T18:00:00Z")).toBe(false)); // 13:00
  it("starts exactly at 23:00", () => expect(quiet("2026-11-21T04:00:00Z")).toBe(true)); // 23:00 EST
  it("handles spring-forward day", () => {
    expect(quiet("2026-03-08T06:30:00Z")).toBe(true); // 01:30 EST
    expect(quiet("2026-03-08T11:30:00Z")).toBe(false); // 07:30 EDT
  });
  it("handles fall-back day (repeated 01:30)", () => {
    expect(quiet("2026-11-01T05:30:00Z")).toBe(true); // 01:30 EDT
    expect(quiet("2026-11-01T06:30:00Z")).toBe(true); // 01:30 EST
    expect(quiet("2026-11-01T12:00:00Z")).toBe(false); // 07:00 EST
  });
  it("supports a window that does not cross midnight", () => {
    const q = (iso: string) => isQuietHours(new Date(iso), TZ, "13:00", "15:00");
    expect(q("2026-11-20T19:00:00Z")).toBe(true); // 14:00
    expect(q("2026-11-20T21:00:00Z")).toBe(false); // 16:00
  });
});

describe("localDateKey", () => {
  it("uses the configured zone, not UTC", () => {
    expect(localDateKey(new Date("2026-11-20T03:30:00Z"), TZ)).toBe("2026-11-19");
    expect(localDateKey(new Date("2026-11-20T05:01:00Z"), TZ)).toBe("2026-11-20");
  });
});

describe("nextLocalTime", () => {
  it("returns the next wall-clock occurrence across a DST change", () => {
    expect(nextLocalTime(new Date("2026-03-07T20:00:00Z"), TZ, "07:30").toISOString()).toBe(
      "2026-03-08T11:30:00.000Z",
    );
  });
  it("rolls to tomorrow when today's time has passed", () => {
    expect(nextLocalTime(new Date("2026-11-20T13:00:00Z"), TZ, "07:30").toISOString()).toBe(
      "2026-11-21T12:30:00.000Z",
    );
  });
});
