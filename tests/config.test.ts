import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("returns the documented defaults for an empty environment", () => {
    const c = loadConfig({});
    expect(c.timezone).toBe("America/New_York");
    expect(c.quietStart).toBe("23:00");
    expect(c.quietEnd).toBe("07:00");
    expect(c.briefingTime).toBe("07:30");
    expect(c.dailyBudgetUsd).toBe(1);
    expect(c.models).toEqual({ cheap: "claude-haiku-5-5", strong: "claude-sonnet-5-5" });
  });

  it("reads the budget from the environment", () => {
    expect(loadConfig({ FUSE_DAILY_BUDGET_USD: "2.5" }).dailyBudgetUsd).toBe(2.5);
  });

  it("rejects a non-numeric budget", () => {
    expect(() => loadConfig({ FUSE_DAILY_BUDGET_USD: "abc" })).toThrow();
  });

  it("rejects an unknown timezone", () => {
    expect(() => loadConfig({ FUSE_TIMEZONE: "Not/AZone" })).toThrow();
  });

  it("rejects malformed times", () => {
    expect(() => loadConfig({ FUSE_QUIET_START: "25:00" })).toThrow();
    expect(() => loadConfig({ FUSE_BRIEFING_TIME: "7:30am" })).toThrow();
  });

  it("passes secrets through without defaults", () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: "k", TELEGRAM_BOT_TOKEN: "t" });
    expect(c.anthropicApiKey).toBe("k");
    expect(c.telegramBotToken).toBe("t");
    expect(loadConfig({}).anthropicApiKey).toBeUndefined();
  });
});
