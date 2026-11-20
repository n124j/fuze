import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliAdapter } from "../src/channels/cli.js";
import type { InboundMessage } from "../src/gateway/types.js";

describe("CliAdapter", () => {
  it("turns each typed line into an owner message on the cli channel", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const adapter = new CliAdapter({ input, output });
    const seen: InboundMessage[] = [];
    await adapter.start(async (m) => void seen.push(m));
    input.write("I prefer afternoon meetings\n");
    input.write("second line\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen.map((m) => m.text)).toEqual(["I prefer afternoon meetings", "second line"]);
    expect(seen[0]).toMatchObject({ channel: "cli", channelUserId: "local", chatId: "local", isPrivate: true });
    await adapter.stop();
  });

  it("writes replies to the output stream", async () => {
    const output = new PassThrough();
    const adapter = new CliAdapter({ input: new PassThrough(), output });
    await adapter.send("local", "hello owner");
    expect(output.read().toString()).toBe("hello owner\n");
  });

  it("has the name the gateway uses to find the owner", () => {
    expect(new CliAdapter({ input: new PassThrough(), output: new PassThrough() }).name).toBe("cli");
  });
});
