import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/drive.readonly",
];

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface StoredToken {
  refreshToken: string;
  accessToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

export interface TokenStore {
  load(): StoredToken | null;
  save(t: StoredToken): void;
}

/** Google refused our credentials; the owner has to sign in again. */
export class GoogleAuthError extends Error {
  constructor(detail = "Google sign-in is missing or expired") {
    super(`${detail}. Run "npm run google-auth" to connect Google again.`);
    this.name = "GoogleAuthError";
  }
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  load(): StoredToken | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && typeof (parsed as StoredToken).refreshToken === "string") {
        return parsed as StoredToken;
      }
      return null;
    } catch {
      return null;
    }
  }

  save(t: StoredToken): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

interface AuthOptions {
  clientId: string;
  clientSecret: string;
  store: TokenStore;
  fetch?: typeof fetch;
  clock?: () => number;
}

const EXPIRY_MARGIN_MS = 60_000;

export class GoogleAuth {
  private readonly fetchFn: typeof fetch;
  private readonly clock: () => number;

  constructor(private readonly opts: AuthOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.clock = opts.clock ?? Date.now;
  }

  async accessToken(): Promise<string> {
    const t = this.opts.store.load();
    if (!t) throw new GoogleAuthError("Google is not connected yet");
    if (t.accessToken && t.expiresAt !== undefined && t.expiresAt - this.clock() > EXPIRY_MARGIN_MS) {
      return t.accessToken;
    }
    return this.refresh();
  }

  /** Always fetch a fresh access token (used after a 401 and when the cached one is nearly expired). */
  async refresh(): Promise<string> {
    const t = this.opts.store.load();
    if (!t) throw new GoogleAuthError("Google is not connected yet");
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: t.refreshToken,
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant") throw new GoogleAuthError("Google sign-in was revoked or expired");
      throw new GoogleApiError(`Google token refresh failed (${res.status})`, res.status);
    }
    this.opts.store.save({
      refreshToken: t.refreshToken,
      accessToken: body.access_token,
      expiresAt: this.clock() + (body.expires_in ?? 3600) * 1000,
    });
    return body.access_token;
  }
}

interface HttpOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const BACKOFF_MS = [500, 1000, 2000];

export class GoogleHttp {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly auth: Pick<GoogleAuth, "accessToken" | "refresh">,
    opts: HttpOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async json<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    opts: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const res = await this.send(method, url, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Raw text response (used for Drive exports). */
  async text(url: string, query?: Record<string, string>): Promise<string> {
    return (await this.send("GET", url, { query })).text();
  }

  private async send(
    method: string,
    url: string,
    opts: { query?: Record<string, string>; body?: unknown },
  ): Promise<Response> {
    const full = opts.query ? `${url}?${new URLSearchParams(opts.query).toString()}` : url;
    const where = `${method} ${new URL(url).pathname}`;
    let refreshed = false;
    let token = await this.auth.accessToken();
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await this.fetchFn(full, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch {
        // network failure: retry like a 5xx
      }
      if (res?.ok) return res;
      if (res?.status === 401) {
        if (refreshed) throw new GoogleAuthError("Google rejected the saved sign-in");
        refreshed = true;
        token = await this.auth.refresh();
        continue;
      }
      // A POST or PATCH that failed with a 5xx or a lost connection may already have been applied, so only
      // reads are repeated; a 429 means Google refused it unprocessed and is safe to repeat for everything.
      const readOnly = method === "GET" || method === "DELETE";
      const retryable = readOnly ? res === null || res.status === 429 || res.status >= 500 : res?.status === 429;
      if (!retryable) throw new GoogleApiError(`Google API ${where} failed (${res?.status ?? "network"})`, res?.status ?? 0);
      if (attempt >= BACKOFF_MS.length) {
        throw new GoogleApiError(`Google API ${where} failed (${res?.status ?? "network"})`, res?.status ?? 0);
      }
      await this.sleep(BACKOFF_MS[attempt]!);
    }
  }
}
