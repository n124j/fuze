import { describe, expect, it, vi } from "vitest";
import { AnthropicLlm, type AnthropicApi } from "../src/llm/anthropic.js";
import type { LlmRequest } from "../src/llm/types.js";

const request: LlmRequest = {
  model: "claude-haiku-5-5",
  system: "You are Fuse.",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
  maxTokens: 1234,
  effort: "low",
};

const okResponse = (over: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  ...over,
});

const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

function fakeClient(script: Array<() => unknown>) {
  let i = 0;
  const create = vi.fn(async (_params: Record<string, unknown>) => {
    const step = script[Math.min(i++, script.length - 1)]!;
    return step() as never;
  });
  const api: AnthropicApi = { messages: { create } };
  return { api, create };
}

describe("AnthropicLlm", () => {
  it("maps the API response into content, stop reason and usage including cache tokens", async () => {
    const { api } = fakeClient([() => okResponse()]);
    const res = await new AnthropicLlm("k", { client: api, sleep: async () => {} }).complete(request);
    expect(res.content).toEqual([{ type: "text", text: "hello" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({
      model: "claude-haiku-5-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    });
  });

  it("sends a cacheable system block, tools, effort and max_tokens", async () => {
    const { api, create } = fakeClient([() => okResponse()]);
    await new AnthropicLlm("k", { client: api, sleep: async () => {} }).complete(request);
    const params = create.mock.calls[0]![0];
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.max_tokens).toBe(1234);
    expect(params.system).toEqual([
      { type: "text", text: "You are Fuse.", cache_control: { type: "ephemeral" } },
    ]);
    expect(params.tools).toEqual(request.tools);
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params).not.toHaveProperty("thinking");
  });

  it("omits tools when none are given", async () => {
    const { api, create } = fakeClient([() => okResponse()]);
    await new AnthropicLlm("k", { client: api, sleep: async () => {} }).complete({ ...request, tools: undefined });
    expect(create.mock.calls[0]![0]).not.toHaveProperty("tools");
  });

  it("keeps non-text blocks such as thinking so they can be replayed unchanged", async () => {
    const blocks = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "ok" }];
    const { api } = fakeClient([() => okResponse({ content: blocks })]);
    const res = await new AnthropicLlm("k", { client: api, sleep: async () => {} }).complete(request);
    expect(res.content).toEqual(blocks);
  });

  it("retries a 429 with exponential backoff and then succeeds", async () => {
    const { api, create } = fakeClient([() => { throw httpError(429); }, () => okResponse()]);
    const sleep = vi.fn(async (_ms: number) => {});
    const res = await new AnthropicLlm("k", { client: api, sleep }).complete(request);
    expect(res.stopReason).toBe("end_turn");
    expect(create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("gives up after maxRetries retries on repeated 500s", async () => {
    const { api, create } = fakeClient([() => { throw httpError(500); }]);
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(new AnthropicLlm("k", { client: api, sleep }).complete(request)).rejects.toThrow("http 500");
    expect(create).toHaveBeenCalledTimes(4); // first try + 3 retries
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000]);
  });

  it("does not retry a 400", async () => {
    const { api, create } = fakeClient([() => { throw httpError(400); }]);
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(new AnthropicLlm("k", { client: api, sleep }).complete(request)).rejects.toThrow("http 400");
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps a refusal and treats other stop reasons as a normal end", async () => {
    const refusal = fakeClient([() => okResponse({ stop_reason: "refusal" })]);
    expect((await new AnthropicLlm("k", { client: refusal.api }).complete(request)).stopReason).toBe("refusal");
    const paused = fakeClient([() => okResponse({ stop_reason: "pause_turn" })]);
    expect((await new AnthropicLlm("k", { client: paused.api }).complete(request)).stopReason).toBe("end_turn");
    const tool = fakeClient([() => okResponse({ stop_reason: "tool_use" })]);
    expect((await new AnthropicLlm("k", { client: tool.api }).complete(request)).stopReason).toBe("tool_use");
  });
});
