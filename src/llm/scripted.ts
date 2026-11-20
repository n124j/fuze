import type { LlmClient, LlmRequest, LlmResponse } from "./types.js";

/** Test double: replays canned responses in order and records every request it receives. */
export class ScriptedLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  private next = 0;

  constructor(private readonly responses: LlmResponse[]) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(structuredClone(req));
    const response = this.responses[this.next++];
    if (!response) throw new Error("ScriptedLlm ran out of responses");
    return response;
  }
}
