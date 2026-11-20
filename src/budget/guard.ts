import type { Db } from "../db.js";
import type { Pricing, Usage } from "../llm/types.js";
import { localDateKey } from "../time.js";

export class BudgetExhaustedError extends Error {
  constructor(message = "daily LLM budget exhausted") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/** Tracks LLM spend per local day against a hard cap. Unknown models fail closed. */
export class BudgetGuard {
  constructor(
    private readonly db: Db,
    private readonly capUsd: number,
    private readonly tz: string,
    private readonly pricing: Pricing,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Record one successful call and return its cost in USD. */
  record(usage: Usage): number {
    const price = this.pricing[usage.model];
    if (!price) throw new Error(`no price configured for model "${usage.model}"`);
    const cost =
      (usage.inputTokens * price.inputPerMTok +
        usage.outputTokens * price.outputPerMTok +
        usage.cacheReadTokens * price.cacheReadPerMTok +
        usage.cacheWriteTokens * price.cacheWritePerMTok) /
      1_000_000;
    const now = this.clock();
    this.db
      .prepare(
        `INSERT INTO budget_usage
           (date_key, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        localDateKey(now, this.tz),
        usage.model,
        cost,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        now.getTime(),
      );
    return cost;
  }

  spentTodayUsd(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM budget_usage WHERE date_key = ?")
      .get(localDateKey(this.clock(), this.tz)) as { total: number };
    return row.total;
  }

  canSpend(): boolean {
    return this.spentTodayUsd() < this.capUsd;
  }

  /** True exactly once per local day, the first time it is asked after the cap is reached. */
  takeExhaustedNotice(): boolean {
    if (this.canSpend()) return false;
    const key = localDateKey(this.clock(), this.tz);
    return this.db.prepare("INSERT OR IGNORE INTO budget_notice(date_key) VALUES (?)").run(key).changes === 1;
  }
}
