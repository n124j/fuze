import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  FileTokenStore,
  GoogleApiError,
  GoogleAuth,
  GoogleAuthError,
  GoogleHttp,
  type StoredToken,
  type TokenStore,
} from "../src/google/auth.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class MemStore implements TokenStore {
  constructor(public token: StoredToken | null) {}
  load() {
    return this.token;
  }
  save(t: StoredToken) {
    this.token = t;
  }
}

const NOW = 1_700_000_000_000;

describe("GoogleAuth", () => {
  it("reuses a token that is still valid", async () => {
    const fetchFn = vi.fn();
    const store = new MemStore({ refreshToken: "r", accessToken: "good", expiresAt: NOW + 600_000 });
    const auth = new GoogleAuth({ clientId: "id", clientSecret: "s", store, fetch: fetchFn, clock: () => NOW });
    expect(await auth.accessToken()).toBe("good");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refreshes a token that expires within 60 seconds and saves the new one", async () => {
    const fetchFn = vi.fn(async () => json(200, { access_token: "fresh", expires_in: 3600 }));
    const store = new MemStore({ refreshToken: "r", accessToken: "old", expiresAt: NOW + 30_000 });
    const auth = new GoogleAuth({ clientId: "id", clientSecret: "s", store, fetch: fetchFn, clock: () => NOW });
    expect(await auth.accessToken()).toBe("fresh");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.token).toEqual({ refreshToken: "r", accessToken: "fresh", expiresAt: NOW + 3_600_000 });
  });

  it("asks the owner to sign in again when Google says invalid_grant", async () => {
    const fetchFn = vi.fn(async () => json(400, { error: "invalid_grant" }));
    const store = new MemStore({ refreshToken: "r" });
    const auth = new GoogleAuth({ clientId: "id", clientSecret: "s", store, fetch: fetchFn, clock: () => NOW });
    await expect(auth.accessToken()).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(auth.accessToken()).rejects.toThrow(/google-auth/);
  });

  it("raises GoogleAuthError when no token has ever been saved", async () => {
    const auth = new GoogleAuth({ clientId: "id", clientSecret: "s", store: new MemStore(null), fetch: vi.fn() });
    await expect(auth.accessToken()).rejects.toBeInstanceOf(GoogleAuthError);
  });
});

describe("GoogleHttp", () => {
  const sleep = vi.fn(async (_ms: number) => {});
  const auth = { accessToken: vi.fn(async () => "tok-secret"), refresh: vi.fn(async () => "tok-new") };

  it("sends the bearer token, query and JSON body", async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => json(200, { ok: 1 }));
    const http = new GoogleHttp(auth, { fetch: fetchFn as never, sleep });
    const out = await http.json<{ ok: number }>("POST", "https://x.test/a", { query: { q: "1" }, body: { a: 2 } });
    expect(out).toEqual({ ok: 1 });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://x.test/a?q=1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-secret");
    expect(init.body).toBe(JSON.stringify({ a: 2 }));
  });

  it("refreshes once and retries on a 401", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: "expired" }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));
    auth.refresh.mockClear();
    const http = new GoogleHttp(auth, { fetch: fetchFn as never, sleep });
    expect(await http.json("GET", "https://x.test/a")).toEqual({ ok: 1 });
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retries 429 and 503 with backoff, then gives up keeping the status", async () => {
    sleep.mockClear();
    const fetchFn = vi.fn(async () => json(503, { error: "busy" }));
    const http = new GoogleHttp(auth, { fetch: fetchFn as never, sleep });
    await expect(http.json("GET", "https://x.test/a")).rejects.toMatchObject({ status: 503 });
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1000, 2000]);
  });

  it("does not retry a 404", async () => {
    const fetchFn = vi.fn(async () => json(404, { error: "nope" }));
    const http = new GoogleHttp(auth, { fetch: fetchFn as never, sleep });
    const err = (await http.json("GET", "https://x.test/a").catch((e: unknown) => e)) as GoogleApiError;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err.status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never puts the token in an error message", async () => {
    const fetchFn = vi.fn(async () => json(500, { error: "boom" }));
    const http = new GoogleHttp(auth, { fetch: fetchFn as never, sleep });
    const err = (await http.json("GET", "https://x.test/a").catch((e: unknown) => e)) as GoogleApiError;
    expect(String(err.message)).not.toContain("tok-secret");
  });
});

describe("FileTokenStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("round-trips a token and keeps the file private", () => {
    const dir = mkdtempSync(join(tmpdir(), "fuse-tok-"));
    dirs.push(dir);
    const store = new FileTokenStore(join(dir, "google-token.json"));
    expect(store.load()).toBeNull();
    store.save({ refreshToken: "r", accessToken: "a", expiresAt: 5 });
    expect(store.load()).toEqual({ refreshToken: "r", accessToken: "a", expiresAt: 5 });
    if (process.platform !== "win32") expect(statSync(join(dir, "google-token.json")).mode & 0o777).toBe(0o600);
  });

  it("treats a corrupt file as no token", () => {
    const dir = mkdtempSync(join(tmpdir(), "fuse-tok-"));
    dirs.push(dir);
    const path = join(dir, "t.json");
    writeFileSync(path, "{not json");
    expect(new FileTokenStore(path).load()).toBeNull();
  });
});

describe("config for Google", () => {
  it("reads client id, secret and VIP senders", () => {
    const c = loadConfig({
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "sec",
      FUSE_VIP_SENDERS: " Boss@Corp.com , mom@x.org ",
    });
    expect(c.googleClientId).toBe("id");
    expect(c.googleClientSecret).toBe("sec");
    expect(c.vipSenders).toEqual(["boss@corp.com", "mom@x.org"]);
  });

  it("defaults to no VIPs", () => {
    expect(loadConfig({}).vipSenders).toEqual([]);
    expect(loadConfig({ FUSE_VIP_SENDERS: "" }).vipSenders).toEqual([]);
  });
});
