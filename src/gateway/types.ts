/** A message from any channel, normalized to one shape. */
export interface InboundMessage {
  channel: string;
  channelUserId: string;
  chatId: string;
  /** True for a one-to-one chat; Fuse never acts on group messages. */
  isPrivate: boolean;
  /** Null for anything that is not text (photo, sticker, voice...). */
  text: string | null;
  receivedAt: Date;
}

export interface ChannelAdapter {
  name: string;
  start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
}
