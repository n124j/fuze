import type { Db } from "../db.js";
import { GoogleApiError, type GoogleHttp } from "./auth.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_NEW_MESSAGES_PER_POLL = 50;

export interface MailItem {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  labels: string[];
  isBulk: boolean;
}

export interface DraftContent {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
}

interface Header {
  name: string;
  value: string;
}
interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}
interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: Part & { headers?: Header[] };
  raw?: string;
}

const headerOf = (headers: Header[] | undefined, name: string): string =>
  headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function noLineBreaks(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${what} contains a line break`);
  return value;
}

const needsEncoding = (s: string) => /[^\x20-\x7e]/.test(s);
const encodeWord = (s: string) => (needsEncoding(s) ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=` : s);
const decodeWords = (s: string) =>
  s.replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b64: string) => Buffer.from(b64, "base64").toString("utf8"));

function buildRaw(d: DraftContent): string {
  const to = d.to.map((a) => noLineBreaks(a, "recipient"));
  const cc = d.cc.map((a) => noLineBreaks(a, "cc recipient"));
  const subject = noLineBreaks(d.subject, "subject");
  const body = Buffer.from(d.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const lines = [
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeWord(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const splitAddresses = (v: string): string[] =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function parseRaw(rawB64: string): DraftContent {
  const text = Buffer.from(rawB64, "base64url").toString("utf8");
  const split = text.search(/\r?\n\r?\n/);
  const head = split === -1 ? text : text.slice(0, split);
  const bodyRaw = split === -1 ? "" : text.slice(split).replace(/^\r?\n\r?\n/, "");
  const h = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  const encoding = (h.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const body = encoding === "base64" ? Buffer.from(bodyRaw.replace(/\s+/g, ""), "base64").toString("utf8") : bodyRaw;
  return {
    to: splitAddresses(h.get("to") ?? ""),
    cc: splitAddresses(h.get("cc") ?? ""),
    subject: decodeWords(h.get("subject") ?? ""),
    body,
  };
}

function plainText(part: Part | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t !== null) return t;
  }
  return null;
}

function toMailItem(m: GmailMessage): MailItem {
  const h = m.payload?.headers;
  const from = headerOf(h, "From");
  const precedence = headerOf(h, "Precedence").toLowerCase();
  return {
    id: m.id,
    threadId: m.threadId ?? m.id,
    from,
    subject: headerOf(h, "Subject"),
    snippet: m.snippet ?? "",
    receivedAt: new Date(Number(m.internalDate ?? 0)),
    labels: m.labelIds ?? [],
    isBulk:
      headerOf(h, "List-Unsubscribe") !== "" ||
      precedence === "bulk" ||
      precedence === "list" ||
      /(^|[<\s])no-?reply@/i.test(from),
  };
}

export class GmailClient {
  constructor(private readonly http: Pick<GoogleHttp, "json">) {}

  async currentHistoryId(): Promise<string> {
    return (await this.http.json<{ historyId: string }>("GET", `${BASE}/profile`)).historyId;
  }

  /** New INBOX arrivals since `historyId`. An expired id never backfills: it resets to "now". */
  async newMessagesSince(historyId: string): Promise<{ items: MailItem[]; historyId: string }> {
    const ids: string[] = [];
    let latest = historyId;
    let pageToken: string | undefined;
    try {
      do {
        const query: Record<string, string> = { startHistoryId: historyId, historyTypes: "messageAdded", labelId: "INBOX" };
        if (pageToken) query.pageToken = pageToken;
        const page = await this.http.json<{
          history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
          nextPageToken?: string;
          historyId?: string;
        }>("GET", `${BASE}/history`, { query });
        for (const h of page.history ?? []) {
          for (const a of h.messagesAdded ?? []) {
            if (a.message.labelIds?.includes("INBOX") && !ids.includes(a.message.id)) ids.push(a.message.id);
          }
        }
        latest = page.historyId ?? latest;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (err instanceof GoogleApiError && err.status === 404) {
        return { items: [], historyId: await this.currentHistoryId() };
      }
      throw err;
    }
    const items: MailItem[] = [];
    for (const id of ids.slice(0, MAX_NEW_MESSAGES_PER_POLL)) {
      try {
        const m = await this.http.json<GmailMessage>("GET", `${BASE}/messages/${encodeURIComponent(id)}`, {
          query: { format: "metadata", metadataHeaders: "From,Subject,List-Unsubscribe,Precedence" },
        });
        items.push(toMailItem(m));
      } catch (err) {
        // Deleted before we could read it: nothing to announce, and it must not block the rest.
        if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
      }
    }
    return { items, historyId: latest };
  }

  async readMessage(id: string, maxChars = 4000): Promise<string> {
    const m = await this.http.json<GmailMessage>("GET", `${BASE}/messages/${id}`, { query: { format: "full" } });
    return (plainText(m.payload) ?? m.snippet ?? "").slice(0, maxChars);
  }

  async createDraft(d: DraftContent & { threadId?: string }): Promise<{ draftId: string }> {
    const raw = buildRaw(d);
    const res = await this.http.json<{ id: string }>("POST", `${BASE}/drafts`, {
      body: { message: { raw, ...(d.threadId ? { threadId: d.threadId } : {}) } },
    });
    return { draftId: res.id };
  }

  async getDraft(draftId: string): Promise<DraftContent> {
    const res = await this.http.json<{ message?: { raw?: string } }>("GET", `${BASE}/drafts/${draftId}`, {
      query: { format: "raw" },
    });
    if (!res.message?.raw) throw new Error("draft has no content");
    return parseRaw(res.message.raw);
  }

  async sendDraft(draftId: string): Promise<{ messageId: string }> {
    const res = await this.http.json<{ id: string }>("POST", `${BASE}/drafts/send`, { body: { id: draftId } });
    return { messageId: res.id };
  }
}

export class SeenItems {
  constructor(private readonly db: Db) {}

  has(source: string, id: string): boolean {
    return this.db.prepare("SELECT 1 FROM seen_items WHERE source = ? AND id = ?").get(source, id) !== undefined;
  }

  /** True the first time `(source, id)` is seen, false afterwards. */
  markIfNew(source: string, id: string): boolean {
    return (
      this.db.prepare("INSERT OR IGNORE INTO seen_items (source, id, seen_at) VALUES (?, ?, ?)").run(source, id, Date.now())
        .changes === 1
    );
  }
}

export class ConnectorState {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM connector_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO connector_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}
