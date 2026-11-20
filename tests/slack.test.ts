import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/agent/tools.js";
import { openDb } from "../src/db.js";
import { ConnectorState, SeenItems } from "../src/google/gmail.js";
import { SlackApiError, SlackAuthError, SlackClient, type SlackItem } from "../src/slack/client.js";
import { SlackPoll } from "../src/slack/poll.js";
import { registerSlackTools } from "../src/slack/tools.js";

const TOKEN = "xoxp-secret-token";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(route: (method: string, params: URLSearchParams) => Response) {
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    return route(u.pathname.replace("/api/", ""), u.searchParams);
  });
  return { slack: new SlackClient(TOKEN, { fetch: fetchFn as unknown as typeof fetch }), fetchFn };
}

const match = (ts: string, text: string, opts: { user?: string; im?: boolean; channel?: string } = {}) => ({
  ts,
  text,
  user: opts.user ?? "U_OTHER",
  username: "sam",
  channel: { id: opts.channel ?? "C1", name: "general", is_im: opts.im ?? false },
});
const search = (...matches: object[]) => json({ ok: true, messages: { matches } });

describe("SlackClient", () => {
  it("looks up the owner and sends the token as a bearer header", async () => {
    const { slack, fetchFn } = client(() => json({ ok: true, user_id: "U_ME" }));
    expect(await slack.whoAmI()).toEqual({ userId: "U_ME" });
    const init = fetchFn.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("treats a bad token as an auth error that never contains the token", async () => {
    for (const code of ["invalid_auth", "token_revoked", "not_authed", "account_inactive"]) {
      const { slack } = client(() => json({ ok: false, error: code }));
      const err = await slack.whoAmI().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SlackAuthError);
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });

  it("raises an api error for rate limits and other failures", async () => {
    const limited = client(() => json({ ok: false, error: "ratelimited" }, 429));
    const err = await limited.slack.whoAmI().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).status).toBe(429);
    const other = client(() => json({ ok: false, error: "internal_error" }));
    await expect(other.slack.whoAmI()).rejects.toBeInstanceOf(SlackApiError);
  });

  it("finds new direct messages and mentions, oldest first, without the owner's own messages", async () => {
    const queries: string[] = [];
    const { slack } = client((method, params) => {
      expect(method).toBe("search.messages");
      expect(params.get("sort")).toBe("timestamp");
      expect(params.get("sort_dir")).toBe("desc");
      expect(params.get("count")).toBe("50");
      const q = params.get("query")!;
      queries.push(q);
      if (q.includes("is:dm")) {
        return search(
          match("300.0", "newest dm", { im: true, channel: "D1" }),
          match("250.0", "my own reply", { im: true, channel: "D1", user: "U_ME" }),
          match("100.0", "too old", { im: true, channel: "D1" }),
        );
      }
      return search(match("200.0", "hey <@U_ME> look", { channel: "C9" }), match("300.0", "newest dm", { im: true, channel: "D1" }));
    });
    const items = await slack.findNew("U_ME", 150);
    expect(queries).toEqual(expect.arrayContaining([expect.stringContaining("is:dm"), "<@U_ME>"]));
    expect(items.map((i) => [i.ts, i.kind])).toEqual([
      [200, "mention"],
      [300, "dm"],
    ]);
    expect(items[1]!.key).toBe("D1:300.0");
    expect(items[1]!.where).toBe("direct message");
    expect(items[0]!.where).toBe("#general");
  });

  it("searches by free text", async () => {
    const { slack } = client((_m, params) => {
      expect(params.get("query")).toBe("budget");
      expect(params.get("count")).toBe("10");
      return search(match("1.0", "the budget is set"));
    });
    const items = await slack.search("budget");
    expect(items[0]!.text).toBe("the budget is set");
  });
});

const item = (ts: number, over: Partial<SlackItem> = {}): SlackItem => ({
  key: `C1:${ts}`,
  kind: "dm",
  from: "sam",
  where: "direct message",
  text: "hello",
  ts,
  ...over,
});

function pollSetup(findNew: (userId: string, since: number) => Promise<SlackItem[]>, notify = vi.fn(async () => ({}) as never)) {
  const db = openDb(":memory:");
  const seen = new SeenItems(db);
  const state = new ConnectorState(db);
  const clock = () => new Date("2026-11-20T15:00:00Z");
  const poll = new SlackPoll({
    client: { findNew: vi.fn(findNew) },
    userId: "U_ME",
    seen,
    state,
    notifier: { notify },
    tz: "America/New_York",
    clock,
  });
  return { poll, seen, state, notify };
}

describe("SlackPoll", () => {
  it("only records a starting point on the first run", async () => {
    const findNew = vi.fn(async () => [item(1)]);
    const { poll, state, notify } = pollSetup(findNew);
    expect(await poll.pollOnce()).toBe(0);
    expect(findNew).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(Number(state.get("slack.lastTs"))).toBe(Date.parse("2026-11-20T15:00:00Z") / 1000);
  });

  it("notifies new items once, tidied, and advances", async () => {
    const long = "x".repeat(300);
    const items = [
      item(1_800_000_001, { text: "line one\nline two" }),
      item(1_800_000_002, { kind: "mention", where: "#general", text: long }),
    ];
    const { poll, state, notify, seen } = pollSetup(async () => items);
    state.set("slack.lastTs", "1800000000");
    expect(await poll.pollOnce()).toBe(2);
    const calls = notify.mock.calls as unknown as [{ dedupeKey: string; priority: string; text: string }][];
    expect(calls[0]![0]).toMatchObject({ dedupeKey: "slack:C1:1800000001", priority: "normal", text: "Slack DM from sam: line one line two" });
    expect(calls[1]![0].text.startsWith("Slack mention in #general from sam: ")).toBe(true);
    expect(calls[1]![0].text.length).toBeLessThan(260);
    expect(seen.has("slack", "C1:1800000002")).toBe(true);
    expect(Number(state.get("slack.lastTs"))).toBe(1_800_000_002);
    await poll.pollOnce();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does not lose the undelivered item when sending fails part-way", async () => {
    const notify = vi.fn(async (n: { dedupeKey: string }) => {
      if (n.dedupeKey.endsWith("1800000002")) throw new Error("telegram down");
      return {} as never;
    });
    const { poll, state, seen } = pollSetup(async () => [item(1_800_000_001), item(1_800_000_002)], notify as never);
    state.set("slack.lastTs", "1800000000");
    await expect(poll.pollOnce()).rejects.toThrow("telegram down");
    expect(seen.has("slack", "C1:1800000001")).toBe(true);
    expect(seen.has("slack", "C1:1800000002")).toBe(false);
    expect(Number(state.get("slack.lastTs"))).toBe(1_800_000_001);
  });

  it("tells the owner once a day when the Slack token stops working", async () => {
    const { poll, state, notify } = pollSetup(async () => {
      throw new SlackAuthError();
    });
    state.set("slack.lastTs", "1800000000");
    expect(await poll.pollOnce()).toBe(0);
    await poll.pollOnce();
    const calls = notify.mock.calls as unknown as [{ dedupeKey: string; priority: string; text: string }][];
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatchObject({ dedupeKey: "slack-auth:2026-11-20", priority: "urgent" });
    expect(calls[0]![0].text).toContain("slack-setup");
  });

  it("rethrows other Slack errors so the job retries", async () => {
    const { poll, state } = pollSetup(async () => {
      throw new SlackApiError("ratelimited", 429, "ratelimited");
    });
    state.set("slack.lastTs", "1800000000");
    await expect(poll.pollOnce()).rejects.toBeInstanceOf(SlackApiError);
  });
});

describe("slack_search tool", () => {
  it("wraps results as untrusted and caps them", async () => {
    const many = Array.from({ length: 15 }, (_v, i) => item(i + 1, { text: `msg ${i}` }));
    const reg = new ToolRegistry();
    registerSlackTools(reg, { client: { search: vi.fn(async () => many) } });
    const out = await reg.execute("slack_search", { query: "budget" }, { approved: false });
    expect(out.startsWith("<untrusted_slack>")).toBe(true);
    expect(out.trimEnd().endsWith("</untrusted_slack>")).toBe(true);
    expect(out.match(/^sam \|/gm)).toHaveLength(10);
  });

  it("says so when nothing matches", async () => {
    const reg = new ToolRegistry();
    registerSlackTools(reg, { client: { search: vi.fn(async () => []) } });
    expect(await reg.execute("slack_search", { query: "zzz" }, { approved: false })).toContain("No Slack messages");
  });
});
