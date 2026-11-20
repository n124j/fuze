import { join } from "node:path";
import { ApprovalGate, type Decision } from "./approvals/gate.js";
import { composeBriefing } from "./briefing.js";
import { runAgent } from "./agent/loop.js";
import { ToolRegistry, registerMemoryTools } from "./agent/tools.js";
import { BudgetGuard } from "./budget/guard.js";
import { DEFAULT_PRICING } from "./budget/pricing.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { CalendarClient } from "./google/calendar.js";
import type { DriveClient } from "./google/drive.js";
import { ConnectorState, SeenItems, type GmailClient } from "./google/gmail.js";
import { registerGoogleTools } from "./google/tools.js";
import type { TasksClient } from "./google/tasks.js";
import { PollService } from "./poll.js";
import { triageWithModel } from "./triage/model.js";
import { Gateway, chunkMessage, sendWithFallback } from "./gateway/gateway.js";
import { OwnerRegistry } from "./gateway/owner.js";
import type { ChannelAdapter, InboundAction } from "./gateway/types.js";
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
  /** Google connectors. Without them Fuse still chats, remembers and sends briefings, with less in them. */
  google?: {
    gmail: Pick<GmailClient, "readMessage" | "createDraft" | "getDraft" | "sendDraft" | "currentHistoryId" | "newMessagesSince">;
    calendar: Pick<CalendarClient, "listBetween" | "createEvent">;
    tasks: Pick<TasksClient, "listOpen" | "create">;
    drive: Pick<DriveClient, "search" | "readText">;
  };
}

const DECISION_TEXT: Record<Decision, string> = {
  sent: "Sent.",
  rejected: "Okay, I won't send it. Nothing was sent.",
  expired: "That request expired after 24 hours, so nothing was sent. Ask me again if you still want it sent.",
  changed: "The draft changed after the request, so I did not send it. Ask me to send it again to approve the new version.",
  "already-decided": "That one was already handled.",
  "unknown-id": "I don't recognize that request.",
  "send-unconfirmed":
    "I'm not sure whether that email went out. Please check your Gmail Sent folder. I will not try to send it again.",
};

export interface App {
  memory: MemoryStore;
  budget: BudgetGuard;
  tools: ToolRegistry;
  owners: OwnerRegistry;
  queue: JobQueue;
  approvals?: ApprovalGate;
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

  let gate: ApprovalGate | undefined;
  const handlersFromGoogle: Record<string, Handler> = {};
  if (deps.google) {
    const g = deps.google;
    const askOwner = async (text: string, approvalId: string): Promise<void> => {
      for (const adapter of adapters) {
        const chat = owners.ownerChat(adapter.name);
        if (!chat) continue;
        await sendWithFallback(adapter, chat, text, [
          { id: `approve:${approvalId}`, label: "Approve" },
          { id: `reject:${approvalId}`, label: "Reject" },
        ]);
        return;
      }
      throw new Error("no owner is paired on any channel");
    };
    gate = new ApprovalGate(db, g.gmail, askOwner, clock);
    registerGoogleTools(tools, { ...g, gate, tz });
    const poll = new PollService({
      gmail: g.gmail,
      calendar: g.calendar,
      seen: new SeenItems(db),
      state: new ConnectorState(db),
      notifier,
      triage: (items) => triageWithModel({ llm, budget, model: config.models.cheap }, items),
      vip: config.vipSenders,
      tz,
      clock,
    });
    handlersFromGoogle.poll = async () => {
      await poll.pollOnce();
    };
  }

  const agentDeps = { llm, budget, tools, memory, models: config.models, timezone: config.timezone };
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
      const saved = job.checkpoint as { items: string[]; budgetNotice: boolean; text?: string } | null;
      const snapshot = saved ?? { items: notifier.takeDigest(), budgetNotice: budget.takeExhaustedNotice() };
      if (!saved) ctx.checkpoint(snapshot);
      let text = snapshot.text;
      if (text === undefined) {
        if (deps.google && gate) {
          text = await composeBriefing(
            {
              calendar: deps.google.calendar,
              tasks: deps.google.tasks,
              approvals: gate,
              llm,
              budget,
              model: config.models.strong,
              tz,
              clock,
            },
            snapshot.items,
          );
        } else {
          const lines = ["Good morning."];
          if (snapshot.items.length > 0) lines.push("", ...snapshot.items.map((i) => `• ${i}`));
          else lines.push("Nothing needs your attention right now.");
          text = lines.join("\n");
        }
        // Keep the composed text so a retry after a failed send never pays for the model twice.
        ctx.checkpoint({ ...snapshot, text });
      }
      const out = [text];
      if (snapshot.budgetNotice) out.push("", "I've used today's AI budget, so I'll pause thinking until midnight.");
      await notifier.notify({
        dedupeKey: `briefing:${localDateKey(clock(), tz)}`,
        priority: "normal",
        text: out.join("\n"),
      });
    },
    "flush-deferred": async () => {
      await notifier.flushDeferred();
    },
    heartbeat: async () => {
      // Cheap checks arrive with the connectors in the next plan.
    },
    ...handlersFromGoogle,
    ...deps.extraHandlers,
  };

  const worker = new Worker(queue, handlers, {
    pollMs: WORKER_POLL_MS,
    staleMs: STALE_JOB_MS,
    onBudgetPause: () => nextLocalTime(clock(), tz, "00:00").getTime(),
  });
  const scheduler = new Scheduler(queue, config, clock);
  const onAction = gate
    ? async (action: InboundAction): Promise<string> => {
        const m = /^(approve|reject):([A-Za-z0-9]+)$/.exec(action.actionId);
        if (!m) return "";
        return DECISION_TEXT[await gate!.decide(m[2]!, m[1] as "approve" | "reject")];
      }
    : undefined;
  const gateway = new Gateway({ owners, adapters, respond, db, onAction });

  return {
    memory,
    budget,
    tools,
    owners,
    queue,
    approvals: gate,
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
