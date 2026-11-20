/** The Slack token is missing, revoked or invalid; the owner has to create a new one. */
export class SlackAuthError extends Error {
  constructor(detail = "Slack sign-in is missing or no longer valid") {
    super(`${detail}. See docs/slack-setup.md to create a new token.`);
    this.name = "SlackAuthError";
  }
}

export class SlackApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "SlackApiError";
  }
}

export interface SlackItem {
  /** `<channelId>:<ts>`, unique per message. */
  key: string;
  kind: "dm" | "mention";
  from: string;
  where: string;
  text: string;
  /** Slack timestamp in seconds, as a number. */
  ts: number;
}

interface SlackMatch {
  ts?: string;
  text?: string;
  user?: string;
  username?: string;
  channel?: { id?: string; name?: string; is_im?: boolean };
}

const AUTH_ERRORS = new Set(["invalid_auth", "token_revoked", "not_authed", "account_inactive", "token_expired"]);
const SEARCH_COUNT = "50";

function toItem(m: SlackMatch): SlackItem | null {
  if (!m.ts || !m.channel?.id) return null;
  const isDm = m.channel.is_im === true;
  return {
    key: `${m.channel.id}:${m.ts}`,
    kind: isDm ? "dm" : "mention",
    from: m.username || m.user || "someone",
    where: isDm ? "direct message" : `#${m.channel.name ?? "channel"}`,
    text: m.text ?? "",
    ts: Number(m.ts),
  };
}

/** Read-only Slack access using the owner's user token (search only). It cannot post or change anything. */
export class SlackClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly token: string,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async whoAmI(): Promise<{ userId: string }> {
    const body = await this.call("auth.test", {});
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    if (!userId) throw new SlackApiError("Slack did not say who the token belongs to", 200, "no_user");
    return { userId };
  }

  /** Direct messages and mentions newer than `sinceTs`, oldest first, excluding the owner's own messages. */
  async findNew(userId: string, sinceTs: number): Promise<SlackItem[]> {
    const dms = await this.searchRaw("is:dm");
    const mentions = await this.searchRaw(`<@${userId}>`);
    const byKey = new Map<string, SlackItem>();
    // Direct messages first so a message found by both searches is reported as a DM.
    for (const m of [...dms, ...mentions]) {
      if (m.user === userId) continue;
      const item = toItem(m);
      if (item && item.ts > sinceTs && !byKey.has(item.key)) byKey.set(item.key, item);
    }
    return [...byKey.values()].sort((a, b) => a.ts - b.ts);
  }

  async search(query: string, limit = 10): Promise<SlackItem[]> {
    const matches = await this.searchRaw(query, String(limit));
    return matches.map(toItem).filter((i): i is SlackItem => i !== null);
  }

  private async searchRaw(query: string, count = SEARCH_COUNT): Promise<SlackMatch[]> {
    const body = await this.call("search.messages", { query, sort: "timestamp", sort_dir: "desc", count });
    const matches = (body.messages as { matches?: SlackMatch[] } | undefined)?.matches;
    return Array.isArray(matches) ? matches : [];
  }

  private async call(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `https://slack.com/api/${method}?${new URLSearchParams(params).toString()}`;
    const res = await this.fetchFn(url, { method: "GET", headers: { Authorization: `Bearer ${this.token}` } });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (res.status === 429) throw new SlackApiError("Slack asked us to slow down (429)", 429, "ratelimited");
    if (body.ok === true) return body;
    const code = body.error ?? "unknown_error";
    if (AUTH_ERRORS.has(code)) throw new SlackAuthError();
    throw new SlackApiError(`Slack ${method} failed (${code})`, res.status, code);
  }
}
