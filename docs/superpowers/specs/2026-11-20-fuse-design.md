# Fuse: Personal AI Agent — Design

Date: 2026-11-20
Status: Draft for approval

## Intent and why

Fuse is a personal assistant for one user (the owner) that looks after their day-to-day: it keeps them updated on email, calendar, reminders and schedule, works in the background while they are away, and reaches out proactively when something deserves attention. It is modelled on the architecture in "Designing a Personal AI Agent" (Fuse as a competitor to Muse/Dots): personalization, connectivity, persistent execution, proactivity, multi-channel communication.

The owner wants a useful daily assistant, not a demo. It must also be cheap to run: the LLM is a scarce resource (token budget matters), so it must not be called constantly.

## Goals

1. **Personalization.** Remembers the owner's preferences, ongoing projects and past decisions across conversations (profile, long-term memory, daily memory files; retrieval later).
2. **Connectivity.** Reads/acts on: Gmail, Google Calendar, Google Drive, Slack, Apple Calendar, Apple Reminders, Google Tasks (stands in for "Google Reminders", which Google has merged into Tasks/Calendar).
3. **Persistent execution.** Long tasks survive closing the chat and process crashes: job queue, checkpoints, retries, idempotency.
4. **Proactivity.** Wakes on schedules, heartbeats and events; decides whether anything is worth the owner's attention; notifies accordingly.
5. **Multi-channel.** One gateway with channel adapters. Telegram first; a local CLI/chat channel for development; WhatsApp later as another adapter.
6. **Token thrift.** LLM is called only when plain code cannot decide.

## Non-goals (v1)

- Multi-user / multi-tenant hosting, signup, billing. One owner only.
- Cloud deployment. It runs on the owner's always-on Mac.
- Voice, web UI, mobile app.
- WhatsApp (deferred; Google Voice number may not verify, official API needs Meta setup).
- Vector-database memory retrieval (deferred; files first).
- Evals suite and full tracing UI (basic logging only in v1).

## Anti-goals (a failure even if it technically works)

- Sends any email without explicit owner approval.
- Pings the owner during sleeping hours for non-urgent things.
- Burns tokens polling the LLM on a timer when nothing changed.
- Sends duplicate notifications or duplicate actions (double-created events, double-sent anything) after a crash/retry.
- Leaks credentials or email content into logs or to third parties.

## Constraints

- Host: owner's always-on Mac (launchd service). Development happens on Windows 11, so the code must be cross-platform except the Apple connectors, which run only on macOS and must degrade cleanly (disabled, with a clear message) elsewhere.
- Stack: Node.js + TypeScript, single process.
- LLM: Anthropic API with an API key (owner has a Claude subscription, but subscription and API are billed separately; the owner should set a spend cap in the Anthropic console). Fuse also enforces its own daily token/cost budget.
- Telegram via a bot created with BotFather (owner supplies the bot token). Google access via OAuth (owner authorizes once). Slack via a bot token. Secrets are stored outside the repo (env file or OS keychain), never committed or logged.

## Approaches considered

- **A. Lean single-process TypeScript service (chosen).** One background program; markdown-file memory; SQLite for queue, checkpoints, dedup; cron-style scheduler; gateway + Telegram adapter; Google APIs, Slack API, AppleScript/EventKit for Apple apps. Least infrastructure; fits one user. Trade-off: we write a small queue/checkpoint layer ourselves.
- **B. Python + LangGraph + Postgres/Redis (the article's stack).** Built-in checkpointing and queue, but needs Docker and databases on the Mac; heavy for one user.
- **C. Assemble from existing tools (n8n, scheduled Claude tasks + connectors).** Fastest start, but weak control over token use and the approval rule, and teaches less.

Owner chose **A**.

## Decisions made with the owner

- **Primary channel:** Telegram (WhatsApp later). Owner has a spare Google Voice number but WhatsApp acceptance is uncertain; not blocking.
- **Hosting:** always-on Mac.
- **Autonomy:**
  - Creating calendar events and reminders: automatic, no approval.
  - Drafting emails: automatic (saves as a Gmail draft).
  - **Sending email: never without the owner's explicit approval.** Enforced in code, not only by prompt.
- **Briefing:** morning briefing around 7–8 AM.
- **Quiet hours:** no notifications while the owner sleeps, except very important/urgent items.
- **Cost:** must not call the LLM constantly; the owner cares about token usage.

## Architecture (mapped to the article)

1. **Gateway + channel adapters.** Normalizes inbound messages from Telegram (and a local CLI) to one internal format; maps channel identities to the single owner ID; maps conversations to sessions/tasks; asks the owner to disambiguate when a reference is ambiguous.
2. **Agent core.** ReAct loop: LLM with tools, system prompt including profile and standing instructions. Cached prompt prefix.
3. **Memory.** Files: `profile.md` (stable preferences), `memory.md` (long-term decisions/facts), `daily/YYYY-MM-DD.md` (recent activity). Read/write/update tools (update existing preference rather than duplicating). A periodic consolidation job reviews recent days and updates long-term memory ("dreaming"), run rarely to save tokens.
4. **Connectors and tools.** One module per service exposing tools with schemas; a permission layer decides which tools are allowed and which need approval. Skills: reusable instruction files (e.g. morning briefing format, meeting prep) loaded on demand.
5. **Job queue and workers.** SQLite-backed queue; jobs have ids, status, checkpoint state, retry/timeout policy. On crash or restart, unfinished jobs resume from the last checkpoint. Side-effecting actions carry idempotency keys and are recorded so a retry never repeats them.
6. **Triggers.** (a) Scheduled: morning briefing, consolidation, reminders. (b) Heartbeat: periodic cheap checks. (c) Events: v1 uses polling of Gmail/Calendar/Slack on an interval (webhooks need a public URL; deferred).
7. **Decision engine (token-thrifty).** Pipeline per new item: (1) deterministic rules (known senders, keywords, calendar proximity, mailing-list headers) filter obvious noise with no LLM; (2) a small/cheap model triages what is left in batches; (3) a stronger model is used only for drafting, planning and the briefing; (4) result is one of: act, draft, ask approval, notify, save for briefing, ignore.
8. **Notification controls.** Priority levels, quiet hours (urgent override only), deduplication (same item never notified twice), batching of low-priority items into the next briefing.
9. **Budget guard.** Tracks tokens/cost per day; hard daily cap; when hit, Fuse falls back to rules-only and tells the owner once.
10. **Safety/ops.** Approval gate for sends; structured logs with secrets and message bodies redacted; runs as a launchd service with restart on failure.

## Build order (suggested; the plan may refine)

1. Core: agent loop, memory files, local CLI channel, budget guard.
2. Queue, checkpoints, idempotency, scheduler.
3. Telegram adapter + notification controls (quiet hours, dedup).
4. Google connectors (Gmail with draft-only, Calendar, Tasks, Drive), approval gate.
5. Decision engine with rules + cheap-model triage; morning briefing skill.
6. Apple Calendar/Reminders (macOS only), Slack.
7. launchd packaging; consolidation job.

## Left to the builder

Exact libraries (Telegram, SQLite, scheduler), file/module layout, prompt wording, polling intervals, the specific rules in the triage layer, which models fill the cheap/strong roles, test strategy, and the precise definition of "very urgent" (starting proposal: replies/messages from the owner's VIP list, calendar changes within the next few hours, and anything the owner has told Fuse to treat as critical). Quiet hours default to a configurable window (proposal: 23:00–07:00 local time; briefing at 07:30).

## Designer's calls after review (owner can override)

- **Approval flow:** the owner approves a send with an inline Telegram button. The approval is for a frozen draft (recipients + body hash). If the draft changes after approval, the approval is void and Fuse asks again. Pending approvals expire after 24 hours. Fuse sends the approved draft itself through the Gmail API (needs the gmail.send scope, used only by the approval gate).
- **Owner identity:** the owner's Telegram user ID is set in config (bootstrapped with a one-time pairing code on first run). The bot silently ignores everyone else.
- **Slack and Drive:** read-only in v1. Any write (post, DM, edit, share) is out of scope until the owner asks for it, and would go through the approval gate.
- **First run:** Fuse only looks at items newer than install time. No backfill of old mail or calendar history.
- **Gmail polling:** by history ID, with items deduplicated by message ID.
- **Calendars:** new events go to Google Calendar by default. Events appearing in both Google and Apple Calendar are deduplicated by event UID in the briefing.
- **Quiet hours:** follow a configured timezone, not the Mac's clock.
- **Memory safety:** `profile.md` and `memory.md` are backed up (dated copy) before each consolidation run, and the owner gets a short summary of what changed.
- **Budget guard:** when the cap is hit, the morning briefing and approvals still work using rules and cached data; triage and drafting pause.

## Owner's answers after review

- **Google account:** personal Gmail. Designer's call: the Google Cloud OAuth app is set to "In production" publishing status (unverified, single user, owner clicks through Google's warning once) so refresh tokens do not expire after 7 days. The Gmail scopes are readonly, compose (drafts) and send; send is used only by the approval gate.
- **Budget:** $1 per day hard cap (about $30 a month).
- **Privacy:** the owner accepts sending all email content to the Anthropic API. No exclusion list in v1; a sender/label exclusion rule can be added later.
- **Timezone:** US Eastern (America/New_York, follows daylight saving), as a fixed configured timezone. Sleep window not yet stated; the proposed 23:00–07:00 stays as a configurable default.

## Open items for the owner (not blocking the design)

- Their real sleeping window (default 23:00–07:00 ET) and a VIP/important-sender list.
- Anthropic API key and Telegram bot token, supplied when we reach those steps.
