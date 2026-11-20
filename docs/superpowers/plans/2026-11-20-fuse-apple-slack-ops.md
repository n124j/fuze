# Fuse Apple, Slack and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Apple Calendar and Reminders (macOS only), read-only Slack, a weekly memory-consolidation job, and launchd packaging so Fuse runs on the owner's always-on Mac.

**Architecture:** New sources plug into what already exists. Apple Calendar events are merged into the existing calendar port, so the poller, briefing and `calendar_list` tool see them with no changes. Slack and Apple Reminders are new clients behind small interfaces. The `poll` job runs every source independently. Consolidation is a weekly queued job whose model output is a constrained edit list applied by code, never a free rewrite. launchd packaging is a plist renderer plus an install script.

**Tech Stack:** Node 22, TypeScript (strict, NodeNext), vitest, better-sqlite3, zod, croner. Apple access through `osascript` (JXA) with an injectable runner. Slack through plain `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-fuse-design.md`. Plans 1 and 2 are `2026-11-20-fuse-core.md` and `2026-11-20-fuse-google.md`.

## Global Constraints

- Node >= 22, ESM, TypeScript strict with `noUncheckedIndexedAccess`; relative imports end in `.js`.
- Apple connectors run only on macOS and must degrade cleanly elsewhere: disabled, with a clear one-line message, never a crash.
- Slack is read-only: no tool or code path posts, replies, reacts or edits.
- Untrusted text (Slack messages, calendar and reminder titles) is wrapped in `<untrusted_...>` blocks when shown to a model.
- Secrets (`SLACK_USER_TOKEN`) come from `.env`, are never logged and never appear in error messages.
- Quiet hours and timezone follow config, not the Mac's clock. Default timezone `America/New_York`.
- First run: only items newer than install time; no backfill (Slack baseline = now).
- Events present in both Google and Apple Calendar are deduplicated by event UID.
- Memory safety: `profile.md` and `memory.md` are backed up (dated copy) before each consolidation, and the owner gets a short summary of what changed.
- Budget guard: consolidation does nothing when the daily budget is spent (the job is deferred, never run unmetered).
- Daily budget cap stays $1; every model call is recorded through `BudgetGuard`.
- Existing suite stays green after every task (`npm test`), and `npx tsc --noEmit` stays clean.

## Review Focus

Failure modes the spec implies but earlier tasks' main tests would not catch; each has a pinning test in its owning task.

1. **A script runner failure must not take Google down.** Apple Calendar erroring, timing out or being off-platform must leave Google events working (Task 1 merge test, Task 2 runner test).
2. **Titles with quotes, newlines or backticks must not become script code.** Reminder and event text reaches `osascript` only as a JSON argument, never spliced into the script (Task 3).
3. **A revoked Slack token or Slack rate limit must not lose or repeat messages.** One notice per day for a bad token; items are marked seen only after delivery; a 429 fails the job so it retries (Task 4).
4. **A garbage or destructive consolidation answer must leave memory untouched.** Invalid JSON, removing lines that do not exist, removing more than half the lines, or an over-long addition changes nothing (Task 6).
5. **A crash or retry mid-consolidation must not destroy the original backup.** The backup is never overwritten, and re-applying the same edits is a no-op (Task 6).
6. **Install paths with spaces or `&` must produce a valid plist, and installing twice must work.** XML-escaped values; unload-then-load (Task 7).

---

## File Structure

- `src/config.ts` (modify): `slackUserToken?`, `apple` flag.
- `src/google/calendar.ts` (modify): `CalEvent.uid`.
- `src/calendars.ts` (create): `mergeCalendars`.
- `src/apple/osascript.ts` (create): runner, availability check.
- `src/apple/calendar.ts` (create): `AppleCalendarClient`.
- `src/apple/reminders.ts` (create): `RemindersClient`.
- `src/apple/tools.ts` (create): `reminders_list`, `reminders_create` tools.
- `src/slack/client.ts` (create): `SlackClient`, `SlackAuthError`.
- `src/slack/poll.ts` (create): `SlackPoll`.
- `src/slack/tools.ts` (create): `slack_search` tool.
- `src/poll-sources.ts` (create): run several pollers independently.
- `src/briefing.ts` (modify): optional reminders section.
- `src/app.ts`, `src/main.ts` (modify): wiring, startup checks.
- `src/memory/store.ts` (modify): backup and edit helpers.
- `src/memory/consolidate.ts` (create): the consolidation job logic.
- `src/scheduler.ts` (modify): weekly consolidation trigger.
- `src/ops/launchd.ts`, `scripts/launchd.ts` (create): plist rendering and install.
- `docs/slack-setup.md`, `docs/mac-setup.md` (create); `.env.example`, `package.json` (modify).

---

### Task 1: Config flags, event UIDs and the merged calendar

**Files:**
- Modify: `src/config.ts`, `src/google/calendar.ts`, `.env.example`
- Create: `src/calendars.ts`
- Test: `tests/config.test.ts`, `tests/calendar-tasks.test.ts`, `tests/calendars.test.ts`

**Interfaces:**
- Produces: `Config.slackUserToken?: string` (from `SLACK_USER_TOKEN`), `Config.apple: boolean` (from `FUSE_APPLE`, default true; the strings `0`, `false`, `off` and `no` mean false).
- Produces: `CalEvent.uid?: string` (Google's `iCalUID`).
- Produces: `type CalendarPort = Pick<CalendarClient, "listBetween" | "createEvent">` and
  `mergeCalendars(primary: CalendarPort, extras: { name: string; listBetween(from: Date, to: Date): Promise<CalEvent[]> }[], onError: (name: string, err: unknown) => void): CalendarPort`.

- [ ] **Step 1: Write the failing tests**
  - config: `SLACK_USER_TOKEN=xoxp-1` gives `slackUserToken === "xoxp-1"`; unset gives `undefined`; `FUSE_APPLE` unset gives `apple === true`; `FUSE_APPLE=0` gives `false`; `FUSE_APPLE=off` gives `false`.
  - calendar-tasks: a Google event with `iCalUID: "abc@google.com"` maps to `uid === "abc@google.com"`; without it `uid` is `undefined`.
  - calendars: `mergeCalendars` with Google event `{id:"g1", uid:"u1"}` and an extra event `{id:"apple:u1", uid:"u1"}` returns one event (the primary's); two events with no uid but the same lowercased trimmed title and start instant collapse to one; results are sorted by start; an extra whose `listBetween` rejects calls `onError("Apple", err)` and the primary's events still come back (Review Focus 1); if the primary rejects, the merged `listBetween` rejects; `createEvent` is the primary's and extras never receive it.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/config.test.ts tests/calendar-tasks.test.ts tests/calendars.test.ts` (missing properties and module).
- [ ] **Step 3: Implement** the config fields in the schema and `loadConfig`; add `uid` to `CalEvent` and map `iCalUID` in `toEvent` (add `iCalUID?: string` to `GoogleEvent`); create `src/calendars.ts`. Dedup key is `uid` when present, else `title.trim().toLowerCase() + "|" + start.toISOString()`; the primary's events are added first so they win. Add the two env lines to `.env.example`.
- [ ] **Step 4: Run, expect PASS**, then full `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: config flags, event uids and merged calendar"`

---

### Task 2: The Apple script runner and Apple Calendar

**Files:**
- Create: `src/apple/osascript.ts`, `src/apple/calendar.ts`
- Test: `tests/apple.test.ts`

**Interfaces:**
- Consumes: `CalEvent` (Task 1).
- Produces:
  - `type ScriptRunner = (script: string, payload: unknown) => Promise<string>` (returns the script's stdout).
  - `class AppleUnavailableError extends Error`.
  - `createOsascriptRunner(opts?: { platform?: string; execFile?: typeof execFile; timeoutMs?: number }): ScriptRunner`. Off macOS it returns a runner that throws `AppleUnavailableError("Apple apps are only available on macOS")`. On macOS it runs `osascript -l JavaScript -e <script> <JSON.stringify(payload)>` with `timeoutMs` default 60000; a nonzero exit or timeout throws an `Error` whose message is the trimmed stderr (first 300 chars).
  - `checkAppleAccess(run: ScriptRunner): Promise<string | null>`: runs a trivial script (`Application("Calendar").calendars().length`) and returns `null` when it works, else a one-line owner-facing message. For `AppleUnavailableError` the message is the error text; for any other failure it says to allow the terminal or Node under System Settings → Privacy & Security → Automation (Calendar, Reminders).
  - `AppleCalendarClient(run: ScriptRunner)` with `listBetween(from: Date, to: Date): Promise<CalEvent[]>`.

- [ ] **Step 1: Write the failing tests**
  - runner off-macOS (`platform: "win32"`) rejects with `AppleUnavailableError`; on `"darwin"` with a fake `execFile` it is called with `osascript`, args `["-l","JavaScript","-e", script, '{"a":1}']`, and returns stdout; a fake exec error surfaces its stderr text; the exec timeout option equals `timeoutMs`.
  - `checkAppleAccess`: fake runner that works gives `null`; one that throws `AppleUnavailableError` gives that message; one that throws a plain error gives a message containing "Automation".
  - `AppleCalendarClient.listBetween`: a fake runner returning JSON `[{"uid":"U1","title":"Standup","start":"2026-11-21T14:00:00.000Z","end":"2026-11-21T14:15:00.000Z","allDay":false,"location":"Room 2"}]` yields one `CalEvent` with `id === "apple:U1"`, `uid === "U1"`, correct dates, `location`; the runner receives payload `{from, to}` as ISO strings; a malformed entry (missing `start`) is skipped while valid ones remain; output that is not JSON throws.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/apple.test.ts`.
- [ ] **Step 3: Implement.** Validate runner output with a zod array schema; map entries; at most 100 events. The calendar script (constant string in `calendar.ts`, entry point `function run(argv)`) parses `JSON.parse(argv[0])`, loops `Application("Calendar").calendars()`, selects events with `cal.events.whose({_and:[{startDate:{_lessThan:to}},{endDate:{_greaterThan:from}}]})()`, and returns `JSON.stringify` of `{uid: e.uid(), title: e.summary(), start: e.startDate().toISOString(), end: e.endDate().toISOString(), allDay: e.alldayEvent(), location: e.location() || undefined}`. Known limitation (record in `docs/mac-setup.md`, Task 7): Calendar.app scripting returns only the first occurrence of an Apple-native recurring event; recurring events from Google arrive through the Google connector.
- [ ] **Step 4: Run, expect PASS**, then full `npm test` and `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `git commit -m "feat: apple script runner and calendar"`

---

### Task 3: Apple Reminders and their tools

**Files:**
- Create: `src/apple/reminders.ts`, `src/apple/tools.ts`
- Test: `tests/apple-reminders.test.ts`

**Interfaces:**
- Consumes: `ScriptRunner`, `AppleUnavailableError` (Task 2); `runOnce` (`src/idempotency.ts`); `TaskItem` (`src/google/tasks.ts`); `ToolRegistry` (`src/agent/tools.ts`).
- Produces: `RemindersClient(run: ScriptRunner, db: Db, now?: () => number)` with `listOpen(): Promise<TaskItem[]>` (ids prefixed `apple:`) and `create(title: string, due?: Date): Promise<TaskItem>`.
- Produces: `registerAppleTools(reg: ToolRegistry, c: { reminders: Pick<RemindersClient, "listOpen" | "create">; tz: string }): void` registering `reminders_list` and `reminders_create` (`needsApproval: false`).

- [ ] **Step 1: Write the failing tests**
  - `listOpen`: fake runner returns `[{"id":"R1","title":"Call mum","due":"2026-11-21T15:00:00.000Z","list":"Home"},{"id":"R2","title":"Buy milk","due":null,"list":"Home"}]`; result has two `TaskItem`s (`done: false`, `due` a `Date` or `undefined`).
  - `create`: the runner payload is `{title, due}`; the returned item's id is `apple:<new id>`; calling `create` twice with the same title and due within the same hour runs the script once (runOnce); a different hour creates again.
  - Injection (Review Focus 2): a title of `` x"); do shell script "rm -rf ~"; ("`` plus a newline reaches the runner only inside the `payload` object, and the `script` argument is identical to the one used for a harmless title.
  - tools: `reminders_create` with `{title, due?}` (ISO with offset or Z) calls `create` and returns a one-line confirmation; `reminders_list` returns lines with the due date shown in the owner's timezone; an `AppleUnavailableError` from the client comes back as the registry's `Error: ...` string rather than throwing.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Scripts (constants) read `JSON.parse(argv[0])`. Listing: for each `Application("Reminders").lists()`, `list.reminders.whose({completed:false})()`, returning `{id, title: name(), due: dueDate() ? dueDate().toISOString() : null, list: list.name()}`. Creating: build `Reminders.Reminder({name: title, ...(due ? {dueDate: new Date(due)} : {})})` and `push` it onto `Reminders.defaultList().reminders`, returning `JSON.stringify({id})` of the new reminder. Idempotency key follows the Tasks client (sha256 over hour|title|due, prefix `reminder:`). Tool inputs validated with zod; due uses the same `z.iso.datetime({ offset: true })` transform as `src/google/tools.ts`.
- [ ] **Step 4: Run, expect PASS**, then full suite and tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat: apple reminders and tools"`

---

### Task 4: Slack, read-only

**Files:**
- Create: `src/slack/client.ts`, `src/slack/poll.ts`, `src/slack/tools.ts`, `docs/slack-setup.md`
- Test: `tests/slack.test.ts`

**Interfaces:**
- Consumes: `SeenItems`, `ConnectorState` (`src/google/gmail.ts`); `Notifier` (`notify({dedupeKey, priority, text})`); `localDateKey`; `ToolRegistry`.
- Produces:
  - `class SlackAuthError extends Error` (token missing, revoked or invalid) and `class SlackApiError extends Error { status: number; code: string }`.
  - `interface SlackItem { key: string; kind: "dm" | "mention"; from: string; where: string; text: string; ts: number }` (`key` is `<channelId>:<ts>`; `ts` is the Slack timestamp as a number; `where` is the channel name or `"direct message"`).
  - `SlackClient(token: string, opts?: { fetch?: typeof fetch })`: `whoAmI(): Promise<{ userId: string }>`, `findNew(userId: string, sinceTs: number): Promise<SlackItem[]>` (oldest first; excludes the owner's own messages), `search(query: string, limit?: number): Promise<SlackItem[]>`.
  - `SlackPoll(d: { client: Pick<SlackClient, "findNew">; userId: string; seen: SeenItems; state: ConnectorState; notifier: Pick<Notifier, "notify">; tz: string; clock: () => Date })` with `pollOnce(): Promise<number>`.
  - `registerSlackTools(reg: ToolRegistry, c: { client: Pick<SlackClient, "search"> }): void` registering `slack_search` (`needsApproval: false`).

- [ ] **Step 1: Write the failing tests**
  - client (fake `fetch`): `whoAmI` calls `auth.test` with `Authorization: Bearer <token>` and returns `user_id`; `{ok:false,error:"invalid_auth"}` (also `token_revoked`, `not_authed`, `account_inactive`) throws `SlackAuthError`; the token string never appears in any thrown message; HTTP 429 throws `SlackApiError` with `status 429`; other `ok:false` codes throw `SlackApiError`.
  - `findNew`: issues two `search.messages` calls, one for direct messages (`is:dm`) and one for mentions (`<@USERID>`), with `sort=timestamp`, `sort_dir=desc`, `count=50`; returns items whose `ts` is greater than `sinceTs`, deduplicated by `key`, sorted oldest first, with the owner's own messages (`user === userId`) dropped; a message found by both queries appears once as `dm`.
  - poll: first run (no `slack.lastTs` state) stores "now" in seconds and notifies nothing and does not call `findNew` (no backfill); a later run notifies each new item with `priority: "normal"`, `dedupeKey: "slack:<key>"`, text `Slack DM from <from>: <text>` or `Slack mention in <where> from <from>: <text>` (newlines collapsed, text cut to 200 characters), marks each seen only after `notify` resolves (a `notify` that throws on the second item leaves the first marked and the second not, and `lastTs` not advanced past the unmarked item), then advances `slack.lastTs`; an already-seen key is not notified again (Review Focus 3).
  - poll auth failure: `SlackAuthError` produces one `urgent` notification per local day (`dedupeKey: "slack-auth:<date>"`, text telling the owner to create a new Slack token, see `docs/slack-setup.md`) and `pollOnce` returns 0 without throwing; `SlackApiError` (for example 429) is rethrown so the job retries.
  - tool: `slack_search` with `{query}` returns `<untrusted_slack>`-wrapped lines (`from | where | text`), at most 10; an empty result says so.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/slack.test.ts`.
- [ ] **Step 3: Implement.** Slack Web API calls are `GET https://slack.com/api/<method>` with the Bearer token; the response body is `{ ok, error?, ... }`. `search.messages` matches have `ts`, `text`, `user`, `username`, and `channel: { id, name, is_im }`; `kind` is `dm` when `channel.is_im` is true, else `mention`. State key `slack.lastTs` holds the stringified last handled timestamp. Write `docs/slack-setup.md`: create a Slack app from scratch, add the user token scope `search:read` only, install it to the workspace (an admin may need to approve), copy the User OAuth Token (`xoxp-`) into `.env` as `SLACK_USER_TOKEN`. Explain why a user token: a bot token cannot see the owner's direct messages; the scope is read-only.
- [ ] **Step 4: Run, expect PASS**, then full suite and tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat: read-only slack"`

---

### Task 5: Wire everything into the app

**Files:**
- Create: `src/poll-sources.ts`
- Modify: `src/briefing.ts`, `src/app.ts`, `src/main.ts`
- Test: `tests/poll-sources.test.ts`, `tests/briefing.test.ts`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 4; existing `PollService`, `composeBriefing`, `buildApp`.
- Produces: `interface PollSource { name: string; run(): Promise<unknown> }` and `runPollSources(sources: PollSource[]): Promise<void>`. It runs every source in order even if an earlier one fails, then throws the first error.
- Produces: `AppDeps.apple?: { calendar: { listBetween(from: Date, to: Date): Promise<CalEvent[]> }; reminders: Pick<RemindersClient, "listOpen" | "create"> }` and `AppDeps.slack?: { client: Pick<SlackClient, "findNew" | "search">; userId: string }`.
- Produces: `BriefingDeps.reminders?: Pick<RemindersClient, "listOpen">`.

- [ ] **Step 1: Write the failing tests**
  - `runPollSources`: with sources A (throws), B (ok), C (ok), B and C still ran and the first error is rethrown; with none failing it resolves.
  - briefing: with `reminders.listOpen` returning one due today, one overdue, one due next week and one undated, the plain text has a "Reminders:" section listing only due-today and overdue items (at most 10); a rejecting `listOpen` adds the note "I couldn't reach Apple Reminders this morning, so your reminders are missing." and the rest of the briefing is unchanged; omitting `reminders` changes nothing.
  - smoke: `buildApp` with Google, a fake Apple calendar returning an event that duplicates a Google event (same uid) and a fake Slack client; one `poll` job notifies the shared event once, notifies a Slack DM once, and a Slack `SlackApiError` does not stop the calendar or mail poll from running. With `apple` absent, the app builds and registers no `reminders_*` tool; with `apple` present both tools are registered.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `app.ts`: when `deps.apple` is set, `calendar = mergeCalendars(g.calendar, [{ name: "Apple Calendar", listBetween: deps.apple.calendar.listBetween }], (name, err) => console.error(...))` and use `calendar` for the poll service, briefing and Google tools; register `registerAppleTools`; pass `reminders` to the briefing. When `deps.slack` is set, register `registerSlackTools` and build a `SlackPoll`. The `poll` handler becomes `runPollSources([...])` over Google (when present) and Slack (when present). Log lines never include message text.
  - `main.ts`: Apple is enabled when `process.platform === "darwin"` and `config.apple`; call `checkAppleAccess` once and, on a message, print it and leave Apple disabled. Slack is enabled when `config.slackUserToken` is set; call `whoAmI` once and on any failure print one line ("Slack is not connected: ...", no token) and leave Slack disabled. Print one "connected" line per working connector.
- [ ] **Step 4: Run, expect PASS**, then full suite and tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat: wire apple and slack into the app"`

---

### Task 6: Weekly memory consolidation

**Files:**
- Modify: `src/memory/store.ts`, `src/scheduler.ts`, `src/app.ts`
- Create: `src/memory/consolidate.ts`
- Test: `tests/consolidate.test.ts`, `tests/memory.test.ts`, `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `BudgetGuard` (`canSpend()`, `record()`), `LlmClient`, `BudgetExhaustedError`, `Notifier`.
- Produces in `MemoryStore`: `recentDaily(now: Date, days: number): { date: string; text: string }[]` (oldest first, skipping empty days); `backupCore(dateKey: string): string[]` (copies `profile.md` and `memory.md` to `backups/<dateKey>-profile.md` and `backups/<dateKey>-memory.md` next to them; never overwrites an existing backup; returns the paths it created); `writeLongTerm(text: string): void` (atomic).
- Produces: `interface ConsolidationEdits { add: string[]; remove: string[]; summary: string }`;
  `applyEdits(current: string, edits: ConsolidationEdits): { text: string; added: number; removed: number } | { rejected: string }`;
  `consolidateMemory(d: { memory: MemoryStore; llm: LlmClient; budget: BudgetGuard; model: string; tz: string; clock: () => Date }, saved?: ConsolidationEdits): Promise<{ edits: ConsolidationEdits; applied: boolean; message: string }>`.
- Produces in `Scheduler`: `enqueueConsolidate(): void` (queue name `consolidate`, dedupe key `consolidate:<local date>`) and a weekly cron, Sunday 03:00 in the configured timezone (inside quiet hours). No catch-up.

- [ ] **Step 1: Write the failing tests**
  - store: `recentDaily` returns the last 7 days oldest first and skips empty days; `backupCore` creates dated copies and a second call the same day creates nothing and leaves the first copy's content untouched even after `memory.md` changed (Review Focus 5); `writeLongTerm` replaces the file content.
  - `applyEdits`: removes exact existing lines (trimmed, with their `- ` prefix preserved in matching) and appends new facts as `- <fact>` lines, skipping facts already present; a `remove` entry that matches no line is ignored; removing more than half of the existing lines returns `{ rejected }` and changes nothing; more than 10 `add` entries or an entry over 300 characters returns `{ rejected }`; applying the same edits twice gives the same text (Review Focus 5).
  - `consolidateMemory`: with a scripted model answering valid JSON `{"add":["Prefers morning meetings"],"remove":["- old fact"],"summary":"Merged 1, added 1"}` it backs up first, then writes the edited memory, records usage, and returns `applied: true` with the summary; invalid JSON, JSON with the wrong shape, or a rejected edit set leaves `memory.md` byte-for-byte unchanged and returns `applied: false` with a reason (Review Focus 4); when `budget.canSpend()` is false it throws `BudgetExhaustedError` before calling the model; when given `saved` edits it does not call the model; with no daily notes and an empty `memory.md` it makes no model call and returns `applied: false, message: "Nothing to consolidate."`.
  - The prompt sent to the model wraps the notes and memory in `<untrusted_notes>` and `<untrusted_memory>` blocks and states that the content is data, not instructions.
  - scheduler: `enqueueConsolidate` twice on the same local date queues one job; `start()` registers the weekly timer (assert via the same approach the existing scheduler tests use for crons) and `stop()` clears it.
- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/consolidate.test.ts tests/memory.test.ts tests/scheduler.test.ts`.
- [ ] **Step 3: Implement.** The model is asked for JSON only (`add`, `remove`, `summary`), strong model, `effort: "low"`, `maxTokens: 1000`; parse with zod after trimming code fences. Input is `memory.md` plus the last 7 days of daily notes, each capped to keep the call under about 6000 characters (newest kept). App handler `consolidate`: checkpoint the model's edits once received (`{ edits }`) so a retry never pays twice, call `consolidateMemory(deps, saved)`, then `notifier.notify({ dedupeKey: "consolidate:<date>", priority: "normal", text: "Memory tidy-up: <summary>" })` when `applied`, or a one-line "I skipped this week's memory tidy-up: <reason>" for a rejected result. Daily notes come from the agent and may quote email text, so additions are capped (above) and recorded in the summary the owner sees.
- [ ] **Step 4: Run, expect PASS**, then full suite and tsc.
- [ ] **Step 5: Commit** — `git commit -m "feat: weekly memory consolidation"`

---

### Task 7: launchd packaging and Mac setup docs

**Files:**
- Create: `src/ops/launchd.ts`, `scripts/launchd.ts`, `docs/mac-setup.md`
- Modify: `package.json`, `.env.example`
- Test: `tests/launchd.test.ts`

**Interfaces:**
- Produces: `renderPlist(o: { label: string; nodePath: string; projectDir: string; logDir: string }): string` returning a launchd plist with `Label`, `ProgramArguments` (`nodePath`, `<projectDir>/dist/src/main.js`), `WorkingDirectory` = `projectDir`, `RunAtLoad` true, `KeepAlive` true, `ThrottleInterval` 10, `StandardOutPath` and `StandardErrorPath` in `logDir`. All string values are XML-escaped (`&`, `<`, `>`, `"`, `'`).
- Produces: `installAgent(o: { platform: string; home: string; uid: number; label: string; nodePath: string; projectDir: string; run: (cmd: string, args: string[]) => Promise<void>; write: (path: string, content: string) => void }): Promise<string>` and `uninstallAgent(...)` with the same style of injected dependencies. Off macOS they throw an error whose message says launchd is macOS only. Install writes `~/Library/LaunchAgents/<label>.plist`, creates the log directory, runs `launchctl bootout gui/<uid>/<label>` (failure ignored: not loaded yet) and then `launchctl bootstrap gui/<uid> <plist path>`, then `launchctl enable gui/<uid>/<label>`.
- Package scripts: `"launchd:install": "tsx scripts/launchd.ts install"`, `"launchd:uninstall": "tsx scripts/launchd.ts uninstall"`; fix `"start"` to the real build output.

- [ ] **Step 1: Write the failing tests**
  - `renderPlist` output contains each key above; a `projectDir` of `/Users/me/My & Co/fuse` appears as `My &amp; Co` and the result still parses as well-formed XML (check by a simple tag-balance or `DOMParser`-free regex test of `&amp;` presence and absence of a raw `& `) (Review Focus 6); `ProgramArguments` has exactly the two entries in order.
  - `installAgent` with `platform: "darwin"` and fakes issues, in order: `bootout`, `bootstrap`, `enable`, and writes the plist at the expected path; calling it twice works (bootout before each bootstrap) and a `bootout` that rejects does not abort the install; with `platform: "win32"` it throws the macOS-only error and runs and writes nothing; `uninstallAgent` runs `bootout` and removes the plist (via an injected `remove`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Keep the pure functions in `src/ops/launchd.ts` and the real `execFile`/`fs` wiring only in `scripts/launchd.ts` (label `com.fuse.agent`, `nodePath = process.execPath`, `projectDir = process.cwd()`, `logDir = <projectDir>/data/logs`). The build writes to `dist/src/main.js` because `tsconfig.json` has `rootDir: "."`; verify with `npm run build` and fix `"start"` in `package.json` to `node dist/src/main.js` (the current `dist/main.js` does not exist). Write `docs/mac-setup.md`: install Node 22 and `npm install`, copy the `.env`, run `npm run google-auth`, `npm run build`, `npm run launchd:install`, where logs live, how to stop or uninstall, keep-the-Mac-awake setting (System Settings → Energy: prevent automatic sleeping on power adapter), the Automation permission prompts for Calendar and Reminders, the recurring-events limitation from Task 2, and a short "first-run checklist on the Mac" covering the three things that cannot be tested off-Mac (calendar read, reminder create, Slack mention search).
- [ ] **Step 4: Run, expect PASS**; run `npm run build` and confirm `dist/src/main.js` exists; full suite and tsc. Delete `dist/` afterward if it is not git-ignored (check `.gitignore`).
- [ ] **Step 5: Commit** — `git commit -m "feat: launchd packaging and mac setup guide"`

---

## Self-Review

- **Spec coverage:** Apple Calendar and Reminders (Tasks 1 to 3, 5), Slack read-only (Tasks 4, 5), Apple/Google duplicate handling by UID (Task 1), consolidation with backup and owner summary and budget behaviour (Task 6), launchd with restart on failure (Task 7), macOS-only degradation (Tasks 2, 5). Webhooks and WhatsApp remain out of scope, as in the spec.
- **Types:** `CalendarPort` and `mergeCalendars` (Task 1) are consumed in Task 5; `ScriptRunner` (Task 2) in Tasks 3 and 5; `SlackItem`, `SlackClient`, `SlackPoll` (Task 4) in Task 5; `ConsolidationEdits` and `consolidateMemory` (Task 6) only inside Task 6 and the app handler.
- **Rulings to record in the ledger when executing:**
  1. The spec says Slack uses a bot token, but a bot token cannot read the owner's direct messages, so Slack uses a read-only user token (`search:read`).
  2. Event UID is added to `CalEvent` (Google `iCalUID`) so Apple and Google duplicates collapse.
  3. Apple Calendar uses the Calendar.app scripting interface, which lists only the first occurrence of Apple-native recurring events.
  4. Consolidation uses a constrained edit list rather than a rewrite, and only edits `memory.md`; `profile.md` is backed up but not modified.
  5. `package.json` `start` points at a file that does not exist; fixed to `dist/src/main.js`.
- **Cannot be tested on Windows:** the real `osascript` calls, the Calendar and Reminders permission prompts, Slack search syntax against a live workspace, and `launchctl`. All logic around them is unit-tested with fakes; the Mac first-run checklist in `docs/mac-setup.md` covers the rest.
