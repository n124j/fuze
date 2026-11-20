import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PRICING } from "../src/budget/pricing.js";
import { BudgetGuard, BudgetExhaustedError } from "../src/budget/guard.js";
import { loadConfig } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import type { Pricing, Usage } from "../src/llm/types.js";

const TZ = "America/New_York";
const pricing: Pricing = {
  m: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
};
const usage = (over: Partial<Usage> = {}): Usage => ({
  model: "m",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

let db: Db;
let now: Date;
const guard = (cap = 1) => new BudgetGuard(db, cap, TZ, pricing, () => now);

beforeEach(() => {
  db = openDb(":memory:");
  now = new Date("2026-11-20T15:00:00Z");
});

describe("BudgetGuard.record", () => {
  it("prices all four token kinds", () => {
    const cost = guard().record(
      usage({ inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 }),
    );
    expect(cost).toBeCloseTo(1 + 1 + 0.2 + 0.5, 6);
  });

  it("fails closed on a model with no price", () => {
    expect(() => guard().record(usage({ model: "mystery", inputTokens: 10 }))).toThrow(/mystery/);
  });

  it("accumulates spend for the day", () => {
    const g = guard();
    g.record(usage({ inputTokens: 100_000 })); // 0.10
    g.record(usage({ outputTokens: 100_000 })); // 0.20
    expect(g.spentTodayUsd()).toBeCloseTo(0.3, 6);
  });
});

describe("BudgetGuard.canSpend", () => {
  it("is true under the cap and false once the cap is reached", () => {
    const g = guard(1);
    expect(g.canSpend()).toBe(true);
    g.record(usage({ inputTokens: 1_000_000 })); // exactly $1.00
    expect(g.canSpend()).toBe(false);
  });

  it("resets at local midnight, not UTC midnight", () => {
    const g = guard(1);
    now = new Date("2026-11-20T04:59:00Z"); // 23:59 on the 19th in New York
    g.record(usage({ inputTokens: 2_000_000 }));
    expect(g.canSpend()).toBe(false);
    now = new Date("2026-11-20T05:01:00Z"); // 00:01 on the 20th
    expect(g.spentTodayUsd()).toBe(0);
    expect(g.canSpend()).toBe(true);
  });
});

describe("BudgetGuard.takeExhaustedNotice", () => {
  it("is false while there is budget left", () => {
    expect(guard().takeExhaustedNotice()).toBe(false);
  });

  it("fires once per local day after the cap is reached", () => {
    const g = guard(1);
    g.record(usage({ inputTokens: 2_000_000 }));
    expect(g.takeExhaustedNotice()).toBe(true);
    expect(g.takeExhaustedNotice()).toBe(false);
    now = new Date("2026-11-21T15:00:00Z");
    g.record(usage({ inputTokens: 2_000_000 }));
    expect(g.takeExhaustedNotice()).toBe(true);
  });
});

describe("BudgetExhaustedError", () => {
  it("is an Error subclass callers can match on", () => {
    expect(new BudgetExhaustedError()).toBeInstanceOf(Error);
  });
});

describe("DEFAULT_PRICING", () => {
  it("prices both configured default models with positive rates", () => {
    const { models } = loadConfig({});
    for (const id of [models.cheap, models.strong]) {
      const p = DEFAULT_PRICING[id];
      expect(p, id).toBeDefined();
      expect(p!.inputPerMTok).toBeGreaterThan(0);
      expect(p!.outputPerMTok).toBeGreaterThan(0);
      expect(p!.cacheReadPerMTok).toBeGreaterThan(0);
      expect(p!.cacheWritePerMTok).toBeGreaterThan(0);
    }
  });
});
