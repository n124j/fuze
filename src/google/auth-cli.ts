import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { FileTokenStore, GOOGLE_SCOPES, TOKEN_URL } from "./auth.js";

/** One-time sign-in: opens a loopback listener, the owner approves in the browser, we save the refresh token. */
async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // settings may come from the real environment
  }
  const config = loadConfig(process.env);
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see docs/google-setup.md)");
  }

  const state = randomBytes(16).toString("hex");
  const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/plain" });
      res.end(ok ? "Google connected. You can close this tab." : "Sign-in failed. Check the terminal.");
      server.close();
      if (ok) resolve({ code: url.searchParams.get("code")!, redirect: `http://127.0.0.1:${port}/callback` });
      else reject(new Error(url.searchParams.get("error") ?? "state mismatch"));
    });
    // Read once at startup: after server.close() the address is gone.
    let port = 0;
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({
        client_id: config.googleClientId!,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();
      console.log("Open this link in your browser and approve access:\n");
      console.log(auth.toString());
    });
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code.code,
      redirect_uri: code.redirect,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
    }).toString(),
  });
  const body = (await res.json()) as { refresh_token?: string; access_token?: string; expires_in?: number };
  if (!res.ok || !body.refresh_token) throw new Error(`Google did not return a refresh token (${res.status})`);
  new FileTokenStore(join(config.dataDir, "google-token.json")).save({
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  console.log("Google connected");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
