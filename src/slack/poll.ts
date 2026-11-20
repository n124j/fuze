import type { ConnectorState, SeenItems } from "../google/gmail.js";
import type { Notifier } from "../notify/notifier.js";
import { localDateKey } from "../time.js";
import { SlackAuthError, type SlackClient, type SlackItem } from "./client.js";

const STATE_KEY = "slack.lastTs";
const MAX_TEXT = 200;
/** Slack's search index lags, so each check looks back this far; already-seen messages are skipped. */
const LOOKBACK_SECONDS = 15 * 60;

export interface SlackPollDeps {
  client: Pick<SlackClient, "findNew" | "whoAmI">;
  /** Known at startup when Slack answered then; otherwise looked up on the first check that needs it. */
  userId?: string;
  seen: SeenItems;
  state: ConnectorState;
  notifier: Pick<Notifier, "notify">;
  tz: string;
  clock: () => Date;
}

const tidy = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}...` : flat;
};

const describe = (i: SlackItem): string =>
  i.kind === "dm" ? `Slack DM from ${i.from}: ${tidy(i.text)}` : `Slack mention in ${i.where} from ${i.from}: ${tidy(i.text)}`;

/** Checks Slack for new direct messages and mentions and hands each to the notifier once. */
export class SlackPoll {
  private userId: string | undefined;

  constructor(private readonly d: SlackPollDeps) {
    this.userId = d.userId;
  }

  async pollOnce(): Promise<number> {
    const last = this.d.state.get(STATE_KEY);
    if (last === null) {
      // First run: start from now. Old messages are never read or announced.
      this.d.state.set(STATE_KEY, String(this.d.clock().getTime() / 1000));
      return 0;
    }
    try {
      this.userId ??= (await this.d.client.whoAmI()).userId;
      const items = await this.d.client.findNew(this.userId, Number(last) - LOOKBACK_SECONDS);
      let count = 0;
      for (const item of items) {
        if (!this.d.seen.has("slack", item.key)) {
          await this.d.notifier.notify({ dedupeKey: `slack:${item.key}`, priority: "normal", text: describe(item) });
          // Marked only after delivery succeeded, so a failure part-way loses nothing.
          this.d.seen.markIfNew("slack", item.key);
          count++;
        }
        // Never moves backwards: the lookback window can return messages older than the marker.
        if (item.ts > Number(this.d.state.get(STATE_KEY))) this.d.state.set(STATE_KEY, String(item.ts));
      }
      return count;
    } catch (err) {
      if (err instanceof SlackAuthError) {
        // One message per day, and the job still completes: retrying cannot fix a revoked token.
        await this.d.notifier.notify({
          dedupeKey: `slack-auth:${localDateKey(this.d.clock(), this.d.tz)}`,
          priority: "urgent",
          text: "Slack needs a new token. See docs/slack-setup.md, then update SLACK_USER_TOKEN and restart Fuse.",
        });
        return 0;
      }
      throw err;
    }
  }
}
