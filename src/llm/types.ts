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

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
/** Any other block (for example "thinking"): kept untouched so it can be replayed unchanged. */
export interface OtherBlock {
  type: string;
  [key: string]: unknown;
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | OtherBlock;

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: object;
}

export type Effort = "low" | "medium" | "high";

export interface LlmRequest {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  maxTokens: number;
  effort?: Effort;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal";

export interface LlmResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage: Usage;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export function isText(block: ContentBlock): block is TextBlock {
  return block.type === "text" && typeof (block as TextBlock).text === "string";
}

export function isToolUse(block: ContentBlock): block is ToolUseBlock {
  return block.type === "tool_use" && typeof (block as ToolUseBlock).id === "string";
}
