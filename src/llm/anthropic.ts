import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, LlmClient, LlmRequest, LlmResponse, StopReason } from "./types.js";

/** The small slice of the Anthropic SDK this module uses, so tests can inject a fake. */
export interface AnthropicApi {
  messages: { create(params: Record<string, unknown>): Promise<ApiResponse> };
}

interface ApiResponse {
  content: unknown[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

export interface AnthropicLlmOptions {
  client?: AnthropicApi;
  /** Retries after the first attempt (default 3). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const BASE_BACKOFF_MS = 500;

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 408 || status === 409 || status === 429 || status >= 500;
  return err instanceof Anthropic.APIConnectionError;
}

function mapStopReason(reason: string | null): StopReason {
  if (reason === "tool_use" || reason === "max_tokens" || reason === "refusal") return reason;
  return "end_turn";
}

export class AnthropicLlm implements LlmClient {
  private readonly client: AnthropicApi;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(apiKey: string, opts: AnthropicLlmOptions = {}) {
    // The SDK's own retries are off: ours are testable and a failed attempt never reaches the budget.
    this.client = opts.client ?? (new Anthropic({ apiKey, maxRetries: 0 }) as unknown as AnthropicApi);
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages,
    };
    if (req.tools && req.tools.length > 0) params.tools = req.tools;
    if (req.effort) params.output_config = { effort: req.effort };

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.client.messages.create(params);
        return {
          content: res.content as ContentBlock[],
          stopReason: mapStopReason(res.stop_reason),
          usage: {
            model: req.model,
            inputTokens: res.usage.input_tokens,
            outputTokens: res.usage.output_tokens,
            cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryable(err)) throw err;
        await this.sleep(BASE_BACKOFF_MS * 2 ** attempt);
      }
    }
  }
}
