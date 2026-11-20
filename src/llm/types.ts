/** Token counts for one successful model call. `inputTokens` excludes cached tokens, as the Anthropic API reports them. */
export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** USD per million tokens. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export type Pricing = Record<string, ModelPrice>;
