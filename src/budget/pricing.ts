import type { Pricing } from "../llm/types.js";

/**
 * USD per million tokens, from Anthropic's published first-party API rates
 * (https://platform.claude.com/docs/en/about-claude/pricing), as cached in the
 * claude-api skill's model table on 2026-11-03. Re-check before trusting the
 * numbers: a stale price only makes the daily cap inaccurate, never missing.
 *
 * Cache writes use the 5-minute rate, 1.25x input. Anthropic lists no cache-read
 * price for Haiku 5.5; 0.1x input is used, which slightly overestimates (fails safe).
 * Haiku 5.5 charges more above 100K prompt tokens; Fuse prompts stay far below that.
 */
export const DEFAULT_PRICING: Pricing = {
  "claude-haiku-5-5": {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWritePerMTok: 0.125,
  },
  "claude-sonnet-5-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 2.5,
  },
  "claude-opus-5-5": {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 5,
  },
};
