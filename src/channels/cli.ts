import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ChannelAdapter, InboundMessage } from "../gateway/types.js";

export interface CliOptions {
  input?: Readable;
  output?: Writable;
}

/** Development channel: talk to Fuse from the terminal. main.ts pairs the local user as owner. */
export class CliAdapter implements ChannelAdapter {
  readonly name = "cli";
  private readonly input: Readable;
  private readonly output: Writable;
  private rl: Interface | null = null;

  constructor(opts: CliOptions = {}) {
    this.input = opts.input ?? process.stdin;
    this.output = opts.output ?? process.stdout;
  }

  async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
    this.rl = createInterface({ input: this.input });
    this.rl.on("line", (line) => {
      void onMessage({
        channel: "cli",
        channelUserId: "local",
        chatId: "local",
        isPrivate: true,
        text: line,
        receivedAt: new Date(),
      }).catch((err: unknown) => console.error("[cli] handler failed:", err instanceof Error ? err.name : err));
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  async send(_chatId: string, text: string): Promise<void> {
    this.output.write(`${text}\n`);
  }
}
