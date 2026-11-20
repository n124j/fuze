import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { CliAdapter } from "./channels/cli.js";
import { TelegramAdapter } from "./channels/telegram.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import type { ChannelAdapter } from "./gateway/types.js";
import { AnthropicLlm } from "./llm/anthropic.js";

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
  const app = buildApp({ config, db, llm: new AnthropicLlm(config.anthropicApiKey), adapters });

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
