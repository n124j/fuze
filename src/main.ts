import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { CliAdapter } from "./channels/cli.js";
import { TelegramAdapter } from "./channels/telegram.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import type { ChannelAdapter } from "./gateway/types.js";
import { FileTokenStore, GoogleAuth, GoogleHttp } from "./google/auth.js";
import { CalendarClient } from "./google/calendar.js";
import { DriveClient } from "./google/drive.js";
import { GmailClient } from "./google/gmail.js";
import { TasksClient } from "./google/tasks.js";
import { AppleCalendarClient } from "./apple/calendar.js";
import { checkAppleAccess, createOsascriptRunner } from "./apple/osascript.js";
import { RemindersClient } from "./apple/reminders.js";
import { AnthropicLlm } from "./llm/anthropic.js";
import { SlackClient } from "./slack/client.js";

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env file: settings come from the real environment
  }
  const config = loadConfig(process.env);
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");

  const devCli = process.env.FUSE_DEV_CLI === "1";
  const adapters: ChannelAdapter[] = [];
  if (config.telegramBotToken) adapters.push(new TelegramAdapter(config.telegramBotToken));
  if (devCli) adapters.push(new CliAdapter());
  if (adapters.length === 0) {
    throw new Error("No channel configured: set TELEGRAM_BOT_TOKEN, or FUSE_DEV_CLI=1 to talk in this terminal");
  }

  mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(join(config.dataDir, "fuse.db"));

  let google: Parameters<typeof buildApp>[0]["google"];
  const tokenPath = join(config.dataDir, "google-token.json");
  if (config.googleClientId && config.googleClientSecret && existsSync(tokenPath)) {
    const http = new GoogleHttp(
      new GoogleAuth({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, store: new FileTokenStore(tokenPath) }),
    );
    google = { gmail: new GmailClient(http), calendar: new CalendarClient(http, db), tasks: new TasksClient(http, db), drive: new DriveClient(http) };
  } else {
    console.log("Google is not connected (see docs/google-setup.md, then run: npm run google-auth)");
  }

  let apple: Parameters<typeof buildApp>[0]["apple"];
  if (config.apple && process.platform === "darwin") {
    const run = createOsascriptRunner();
    const problem = await checkAppleAccess(run);
    if (problem) {
      console.log(problem);
    } else {
      apple = { calendar: new AppleCalendarClient(run), reminders: new RemindersClient(run, db) };
      console.log("Apple Calendar and Reminders connected");
    }
  }

  let slack: Parameters<typeof buildApp>[0]["slack"];
  if (config.slackUserToken) {
    const client = new SlackClient(config.slackUserToken);
    try {
      slack = { client, userId: (await client.whoAmI()).userId };
      console.log("Slack connected");
    } catch (err) {
      console.log(`Slack is not connected: ${err instanceof Error ? err.message : "unknown error"} (see docs/slack-setup.md)`);
    }
  }

  const app = buildApp({ config, db, llm: new AnthropicLlm(config.anthropicApiKey), adapters, google, apple, slack });

  if (devCli) app.owners.setOwner("cli", "local", "local");
  if (config.telegramBotToken && !app.owners.hasOwner("telegram")) {
    const code = app.owners.createPairingCode();
    console.log(`Not paired yet. Within 15 minutes, send this to your Telegram bot:  /pair ${code}`);
  }

  await app.start();
  console.log(`Fuse is running (${adapters.map((a) => a.name).join(", ")}). Press Ctrl+C to stop.`);

  const shutdown = async () => {
    console.log("Stopping...");
    await app.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
