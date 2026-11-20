import { z } from "zod";

export interface Config {
  timezone: string;
  quietStart: string;
  quietEnd: string;
  briefingTime: string;
  dailyBudgetUsd: number;
  dataDir: string;
  anthropicApiKey?: string;
  telegramBotToken?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  /** Lowercased addresses whose mail is always urgent. */
  vipSenders: string[];
  models: { cheap: string; strong: string };
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24-hour)");

const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "unknown IANA timezone");

const schema = z.object({
  timezone,
  quietStart: hhmm,
  quietEnd: hhmm,
  briefingTime: hhmm,
  dailyBudgetUsd: z.coerce.number().positive().finite(),
  dataDir: z.string().min(1),
  anthropicApiKey: z.string().optional(),
  telegramBotToken: z.string().optional(),
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  vipSenders: z.array(z.string()),
  models: z.object({ cheap: z.string().min(1), strong: z.string().min(1) }),
});

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const get = (key: string): string | undefined => (env[key] === "" ? undefined : env[key]);
  return schema.parse({
    timezone: get("FUSE_TIMEZONE") ?? "America/New_York",
    quietStart: get("FUSE_QUIET_START") ?? "23:00",
    quietEnd: get("FUSE_QUIET_END") ?? "07:00",
    briefingTime: get("FUSE_BRIEFING_TIME") ?? "07:30",
    dailyBudgetUsd: get("FUSE_DAILY_BUDGET_USD") ?? "1",
    dataDir: get("FUSE_DATA_DIR") ?? "./data",
    anthropicApiKey: get("ANTHROPIC_API_KEY"),
    telegramBotToken: get("TELEGRAM_BOT_TOKEN"),
    googleClientId: get("GOOGLE_CLIENT_ID"),
    googleClientSecret: get("GOOGLE_CLIENT_SECRET"),
    vipSenders: (get("FUSE_VIP_SENDERS") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    models: {
      cheap: get("FUSE_MODEL_CHEAP") ?? "claude-haiku-5-5",
      strong: get("FUSE_MODEL_STRONG") ?? "claude-sonnet-5-5",
    },
  });
}
