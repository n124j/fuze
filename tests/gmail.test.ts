import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { GoogleApiError, type GoogleHttp } from "../src/google/auth.js";
import { ConnectorState, GmailClient, SeenItems } from "../src/google/gmail.js";

type Route = (method: string, url: string, opts?: { query?: Record<string, string>; body?: any }) => unknown;

function fakeHttp(route: Route) {
  const json = vi.fn(async (method: string, url: string, opts?: { query?: Record<string, string>; body?: any }) =>
    route(method, url, opts),
  );
  return { http: { json } as unknown as Pick<GoogleHttp, "json">, json };
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));

function metadata(id: string, h: Record<string, string>, extra: Record<string, unknown> = {}) {
  return {
    id,
    threadId: `t-${id}`,
    snippet: "snippet text",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1700000000000",
    payload: { headers: headers(h) },
    ...extra,
  };
}

function inboxRoute(messages: Record<string, ReturnType<typeof metadata>>, added: { id: string; labels: string[] }[]): Route {
  return (_m, url) => {
    if (url.endsWith("/history")) {
      return {
        history: [{ messagesAdded: added.map((a) => ({ message: { id: a.id, threadId: `t-${a.id}`, labelIds: a.labels } })) }],
        historyId: "200",
      };
    }
    const id = url.split("/messages/")[1]!;
    return messages[id];
  };
}

describe("GmailClient.newMessagesSince", () => {
  it("maps inbox arrivals to MailItems and ignores other labels", async () => {
    const { http } = fakeHttp(
      inboxRoute(
        { m1: metadata("m1", { From: "Ann <Ann@Example.com>", Subject: "Lunch?", Date: "x" }) },
        [
          { id: "m1", labels: ["INBOX", "UNREAD"] },
          { id: "m2", labels: ["SENT"] },
        ],
      ),
    );
    const out = await new GmailClient(http).newMessagesSince("100");
    expect(out.historyId).toBe("200");
    expect(out.items).toEqual([
      {
        id: "m1",
        threadId: "t-m1",
        from: "Ann <Ann@Example.com>",
        subject: "Lunch?",
        snippet: "snippet text",
        receivedAt: new Date(1700000000000),
        labels: ["INBOX", "UNREAD"],
        isBulk: false,
      },
    ]);
  });

  it.each([
    ["List-Unsubscribe", { "List-Unsubscribe": "<mailto:u@x.com>", From: "a@b.com" }],
    ["Precedence bulk", { Precedence: "bulk", From: "a@b.com" }],
    ["Precedence list", { Precedence: "list", From: "a@b.com" }],
    ["noreply sender", { From: "Shop <noreply@shop.com>" }],
    ["no-reply sender", { From: "no-reply@shop.com" }],
  ])("flags bulk mail: %s", async (_name, h) => {
    const { http } = fakeHttp(inboxRoute({ m1: metadata("m1", { Subject: "s", ...h }) }, [{ id: "m1", labels: ["INBOX"] }]));
    expect((await new GmailClient(http).newMessagesSince("1")).items[0]!.isBulk).toBe(true);
  });

  it("skips a message that was deleted before it could be read", async () => {
    const { http } = fakeHttp((_m, url) => {
      if (url.endsWith("/history")) {
        return { history: [{ messagesAdded: [{ message: { id: "gone", labelIds: ["INBOX"] } }, { message: { id: "ok", labelIds: ["INBOX"] } }] }], historyId: "300" };
      }
      if (url.endsWith("/messages/gone")) throw new GoogleApiError("gone", 404);
      return metadata("ok", { From: "a@b.com", Subject: "still here" });
    });
    const out = await new GmailClient(http).newMessagesSince("1");
    expect(out.items.map((i) => i.id)).toEqual(["ok"]);
    expect(out.historyId).toBe("300");
  });

  it("follows paging", async () => {
    const calls: unknown[] = [];
    const { http } = fakeHttp((_m, url, opts) => {
      if (url.endsWith("/history")) {
        calls.push(opts?.query?.pageToken);
        return opts?.query?.pageToken
          ? { history: [{ messagesAdded: [{ message: { id: "m2", labelIds: ["INBOX"] } }] }], historyId: "300" }
          : { history: [{ messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] }], nextPageToken: "p2", historyId: "250" };
      }
      return metadata(url.split("/messages/")[1]!, { From: "a@b.com", Subject: "s" });
    });
    const out = await new GmailClient(http).newMessagesSince("1");
    expect(out.items.map((i) => i.id)).toEqual(["m1", "m2"]);
    expect(out.historyId).toBe("300");
    expect(calls).toEqual([undefined, "p2"]);
  });

  it("never backfills when the history id has expired", async () => {
    const { http } = fakeHttp((_m, url) => {
      if (url.endsWith("/history")) throw new GoogleApiError("gone", 404);
      if (url.endsWith("/profile")) return { historyId: "999" };
      throw new Error("must not fetch messages");
    });
    expect(await new GmailClient(http).newMessagesSince("1")).toEqual({ items: [], historyId: "999" });
  });

  it("reads the current history id", async () => {
    const { http } = fakeHttp(() => ({ historyId: "42" }));
    expect(await new GmailClient(http).currentHistoryId()).toBe("42");
  });
});

describe("GmailClient drafts", () => {
  function draftHttp() {
    let raw = "";
    const sent: unknown[] = [];
    const h = fakeHttp((method, url, opts) => {
      if (method === "POST" && url.endsWith("/drafts")) {
        raw = opts!.body.message.raw;
        return { id: "d1" };
      }
      if (method === "GET" && url.endsWith("/drafts/d1")) return { id: "d1", message: { raw } };
      if (method === "POST" && url.endsWith("/drafts/send")) {
        sent.push(opts!.body);
        return { id: "sent-1" };
      }
      throw new Error(`unexpected ${method} ${url}`);
    });
    return { ...h, sent, rawOf: () => Buffer.from(raw, "base64url").toString("utf8") };
  }

  it("round-trips recipients, subject and body", async () => {
    const { http } = draftHttp();
    const gmail = new GmailClient(http);
    const draft = { to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], subject: "Plan for Monday", body: "Line one\n\nLine two" };
    expect(await gmail.createDraft(draft)).toEqual({ draftId: "d1" });
    expect(await gmail.getDraft("d1")).toEqual(draft);
  });

  it("encodes a non-ASCII subject and body and reads them back", async () => {
    const { http, rawOf } = draftHttp();
    const gmail = new GmailClient(http);
    const draft = { to: ["a@x.com"], cc: [], subject: "Café – résumé ✓", body: "Grüße aus Zürich ✓" };
    await gmail.createDraft(draft);
    expect(rawOf()).not.toContain("Café");
    expect(await gmail.getDraft("d1")).toEqual(draft);
  });

  it("rejects header injection in recipients and subject", async () => {
    const { http, json } = draftHttp();
    const gmail = new GmailClient(http);
    await expect(
      gmail.createDraft({ to: ["a@x.com\nBcc: evil@x.com"], cc: [], subject: "s", body: "b" }),
    ).rejects.toThrow(/line break/i);
    await expect(
      gmail.createDraft({ to: ["a@x.com"], cc: [], subject: "s\r\nBcc: evil@x.com", body: "b" }),
    ).rejects.toThrow(/line break/i);
    expect(json).not.toHaveBeenCalled();
  });

  it("sends a draft by id and returns the message id", async () => {
    const { http, sent } = draftHttp();
    expect(await new GmailClient(http).sendDraft("d1")).toEqual({ messageId: "sent-1" });
    expect(sent).toEqual([{ id: "d1" }]);
  });
});

describe("GmailClient.readMessage", () => {
  it("returns the plain-text body, cut at maxChars", async () => {
    const { http } = fakeHttp(() => ({
      id: "m1",
      payload: {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
          { mimeType: "text/plain", body: { data: b64url("x".repeat(50)) } },
        ],
      },
    }));
    const gmail = new GmailClient(http);
    expect(await gmail.readMessage("m1")).toBe("x".repeat(50));
    expect(await gmail.readMessage("m1", 10)).toBe("x".repeat(10));
  });
});

describe("SeenItems and ConnectorState", () => {
  it("marks an item only the first time", () => {
    const seen = new SeenItems(openDb(":memory:"));
    expect(seen.markIfNew("gmail", "m1")).toBe(true);
    expect(seen.markIfNew("gmail", "m1")).toBe(false);
    expect(seen.markIfNew("calendar", "m1")).toBe(true);
  });

  it("stores and overwrites a value", () => {
    const state = new ConnectorState(openDb(":memory:"));
    expect(state.get("gmail.historyId")).toBeNull();
    state.set("gmail.historyId", "10");
    state.set("gmail.historyId", "11");
    expect(state.get("gmail.historyId")).toBe("11");
  });
});

describe("GmailClient search, counts and trash", () => {
  const meta = (id: string, h: Record<string, string>, labels: string[] = ["INBOX"]) => ({
    id,
    threadId: id,
    labelIds: labels,
    internalDate: "1700000000000",
    payload: { headers: headers(h) },
  });

  it("reads the inbox totals from the INBOX label", async () => {
    const { http, json } = fakeHttp(() => ({ messagesTotal: 1200, messagesUnread: 37 }));
    expect(await new GmailClient(http).counts()).toEqual({ inboxTotal: 1200, inboxUnread: 37 });
    expect(json.mock.calls[0]![1]).toContain("/labels/INBOX");
  });

  it("searches with Gmail's own query and summarises each hit", async () => {
    const { http, json } = fakeHttp((_m, url) => {
      if (url.endsWith("/messages")) return { messages: [{ id: "a" }, { id: "b" }], resultSizeEstimate: 2 };
      const id = url.split("/messages/")[1]!;
      return id === "a"
        ? meta("a", { From: "Ann <ann@x.com>", Subject: "Invoice" }, ["INBOX", "UNREAD"])
        : meta("b", { From: "Bob <bob@x.com>", Subject: "Hello" });
    });
    const res = await new GmailClient(http).search("is:unread has:attachment", 20);
    const list = json.mock.calls[0]!;
    expect(list[2]!.query).toMatchObject({ q: "is:unread has:attachment", maxResults: "20" });
    expect(res.total).toBe(2);
    expect(res.exact).toBe(true);
    expect(res.items.map((i) => [i.id, i.unread, i.subject])).toEqual([
      ["a", true, "Invoice"],
      ["b", false, "Hello"],
    ]);
  });

  it("reports an estimate when Gmail has more pages", async () => {
    const { http } = fakeHttp((_m, url) =>
      url.endsWith("/messages") ? { messages: [{ id: "a" }], resultSizeEstimate: 840, nextPageToken: "p2" } : meta("a", { From: "x@y.z", Subject: "s" }),
    );
    const res = await new GmailClient(http).search("older_than:1y", 1);
    expect(res).toMatchObject({ total: 840, exact: false });
  });

  it("returns nothing for a search with no hits", async () => {
    const { http } = fakeHttp(() => ({ resultSizeEstimate: 0 }));
    expect(await new GmailClient(http).search("from:nobody")).toEqual({ total: 0, exact: true, items: [] });
  });

  it("lists ids across pages up to the maximum and says when there are more", async () => {
    const pages: Record<string, { messages: { id: string }[]; nextPageToken?: string }> = {
      "": { messages: [{ id: "1" }, { id: "2" }, { id: "3" }], nextPageToken: "p2" },
      p2: { messages: [{ id: "4" }, { id: "5" }, { id: "6" }], nextPageToken: "p3" },
    };
    const { http } = fakeHttp((_m, _u, opts) => pages[opts?.query?.pageToken ?? ""]);
    const res = await new GmailClient(http).listIds("q", 5);
    expect(res).toEqual({ ids: ["1", "2", "3", "4", "5"], more: true });
  });

  it("moves messages to Trash with one batch call, and does nothing for an empty list", async () => {
    const { http, json } = fakeHttp(() => undefined);
    const gmail = new GmailClient(http);
    await gmail.trash([]);
    expect(json).not.toHaveBeenCalled();
    await gmail.trash(["a", "b"]);
    const [method, url, opts] = json.mock.calls[0]!;
    expect(method).toBe("POST");
    expect(url).toContain("/messages/batchModify");
    expect(opts!.body).toEqual({ ids: ["a", "b"], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
  });

  it("skips a message that vanished while summarising", async () => {
    const { http } = fakeHttp((_m, url) => {
      if (url.endsWith("/a")) throw new GoogleApiError("gone", 404);
      return meta("b", { From: "x@y.z", Subject: "kept" });
    });
    const out = await new GmailClient(http).summaries(["a", "b"]);
    expect(out.map((s) => s.id)).toEqual(["b"]);
  });
});
