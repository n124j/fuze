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

/** A button the owner can tap (for example Approve / Reject). Ids look like "approve:<id>". */
export interface Action {
  id: string;
  label: string;
}

/** The owner tapping an Action, normalized across channels. */
export interface InboundAction {
  channel: string;
  channelUserId: string;
  chatId: string;
  isPrivate: boolean;
  actionId: string;
  receivedAt: Date;
}

export interface ChannelAdapter {
  name: string;
  start(
    onMessage: (m: InboundMessage) => Promise<void>,
    onAction?: (a: InboundAction) => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  /** Optional: show tappable buttons. Adapters without it get slash-command text instead. */
  sendWithActions?(chatId: string, text: string, actions: Action[]): Promise<void>;
}
