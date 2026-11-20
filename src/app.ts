import { join } from "node:path";
import { runAgent } from "./agent/loop.js";
import { ToolRegistry, registerMemoryTools } from "./agent/tools.js";
import { BudgetGuard } from "./budget/guard.js";
import { DEFAULT_PRICING } from "./budget/pricing.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { Gateway, chunkMessage } from "./gateway/gateway.js";
import { OwnerRegistry } from "./gateway/owner.js";
import type { ChannelAdapter } from "./gateway/types.js";
import type { LlmClient, Message, Pricing } from "./llm/types.js";
import { MemoryStore } from "./memory/store.js";
import { Notifier } from "./notify/notifier.js";
import { JobQueue } from "./queue/queue.js";
import { Worker, type Handler } from "./queue/worker.js";
import { Scheduler } from "./scheduler.js";
import { localDateKey, nextLocalTime } from "./time.js";

/** How many past messages (user and assistant, text only) are sent back to the model each turn. */
const MAX_HISTORY_MESSAGES = 20;
const WORKER_POLL_MS = 1000;
const STALE_JOB_MS = 10 * 60 * 1000;

export interface AppDeps {
  config: Config;
  db: Db;
  llm: LlmClient;
  adapters: ChannelAdapter[];
  clock?: () => Date;
  pricing?: Pricing;
  /** Extra job handlers (later plans add connectors and triage here). */
  extraHandlers?: Record<string, Handler>;
}

export interface App {
  memory: MemoryStore;
  budget: BudgetGuard;
  tools: ToolRegistry;
  owners: OwnerRegistry;
  queue: JobQueue;
  worker: Worker;
  notifier: Notifier;
  scheduler: Scheduler;
  gateway: Gateway;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function loadHistory(db: Db, sessionId: string): Message[] {
  const row = db.prepare("SELECT history_json FROM sessions WHERE id = ?").get(sessionId) as
    | { history_json: string }
    | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.history_json);
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(db: Db, sessionId: string, history: Message[], now: number): void {
  db.prepare("UPDATE sessions SET history_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(history),
    now,
    sessionId,
  );
}

export function buildApp(deps: AppDeps): App {
  const { config, db, llm, adapters } = deps;
  const clock = deps.clock ?? (() => new Date());
  const tz = config.timezone;
  const nowMs = () => clock().getTime();

  const pricing = deps.pricing ?? DEFAULT_PRICING;
  // A model with no price would spend money the budget cannot record, so refuse to start.
  for (const model of [config.models.cheap, config.models.strong]) {
    if (!pricing[model]) throw new Error(`No price known for model "${model}"; add it to the pricing table before using it`);
  }

  const memory = new MemoryStore(join(config.dataDir, "memory"), tz);
  const budget = new BudgetGuard(db, config.dailyBudgetUsd, tz, pricing, clock);
  const tools = new ToolRegistry();
  registerMemoryTools(tools, memory);
  const owners = new OwnerRegistry(db, nowMs);
  const queue = new JobQueue(db, nowMs);

  /** Deliver to the owner on the first channel where they are paired. */
  const sendToOwner = async (text: string): Promise<void> => {
    for (const adapter of adapters) {
      const chat = owners.ownerChat(adapter.name);
      if (!chat) continue;
      for (const part of chunkMessage(text)) await adapter.send(chat, part);
      return;
    }
    throw new Error("no owner is paired on any channel");
  };
  const notifier = new Notifier(db, sendToOwner, config, clock);

  const agentDeps = { llm, budget, tools, memory, models: config.models };
  const respond = async (sessionId: string, userText: string): Promise<string> => {
    const history = loadHistory(db, sessionId);
    // The owner is talking to Fuse directly, so use the strong model; cheap models are for background triage.
    const { reply } = await runAgent(agentDeps, { history, userText, tier: "strong", now: clock() });
    const next: Message[] = [
      ...history,
      { role: "user", content: userText },
      { role: "assistant", content: reply },
    ].slice(-MAX_HISTORY_MESSAGES) as Message[];
    saveHistory(db, sessionId, next, nowMs());
    return reply;
  };

  const handlers: Record<string, Handler> = {
    // The digest is taken once and kept in the checkpoint, so a failed send can be retried without losing it.
    briefing: async (job, ctx) => {
      const saved = job.checkpoint as { items: string[]; budgetNotice: boolean } | null;
      const snapshot = saved ?? { items: notifier.takeDigest(), budgetNotice: budget.takeExhaustedNotice() };
      if (!saved) ctx.checkpoint(snapshot);
      const lines = ["Good morning."];
      if (snapshot.items.length > 0) lines.push("", ...snapshot.items.map((i) => `• ${i}`));
      else lines.push("Nothing needs your attention right now.");
      if (snapshot.budgetNotice) lines.push("", "I've used today's AI budget, so I'll pause thinking until midnight.");
      await notifier.notify({
        dedupeKey: `briefing:${localDateKey(clock(), tz)}`,
        priority: "normal",
        text: lines.join("\n"),
      });
    },
    "flush-deferred": async () => {
      await notifier.flushDeferred();
    },
    heartbeat: async () => {
      // Cheap checks arrive with the connectors in the next plan.
    },
    ...deps.extraHandlers,
  };

  const worker = new Worker(queue, handlers, {
    pollMs: WORKER_POLL_MS,
    staleMs: STALE_JOB_MS,
    onBudgetPause: () => nextLocalTime(clock(), tz, "00:00").getTime(),
  });
  const scheduler = new Scheduler(queue, config, clock);
  const gateway = new Gateway({ owners, adapters, respond, db });

  return {
    memory,
    budget,
    tools,
    owners,
    queue,
    worker,
    notifier,
    scheduler,
    gateway,
    async start() {
      await gateway.start();
      worker.start();
      scheduler.start();
    },
    async stop() {
      scheduler.stop();
      await worker.stop();
      await gateway.stop();
    },
  };
}
