# Running Fuse on your Mac

This sets Fuse up to start when you log in, restart itself if it crashes, and keep running in the background. It takes about 15 minutes.

## 1. Install

1. Install Node 22 or newer (<https://nodejs.org/>).
2. Copy the project folder to the Mac, then in Terminal:

   ```
   cd path/to/fuze
   npm install
   ```

3. Copy your `.env` file into the folder (or create it from `.env.example`). It needs at least `ANTHROPIC_API_KEY` and `TELEGRAM_BOT_TOKEN`.
4. Connect Google once on this Mac: `npm run google-auth` (see `docs/google-setup.md`). The sign-in is saved in `data/google-token.json`.
5. Optional: connect Slack (`docs/slack-setup.md`).

## 2. Try it by hand first

```
npm run dev
```

On the Mac, Fuse asks for permission the first time it touches Calendar or Reminders. Click **OK** on each prompt. If you clicked "Don't Allow" by mistake, go to **System Settings → Privacy & Security → Automation**, find Terminal (or Node), and switch Calendar and Reminders on. Then restart Fuse.

You should see lines like "Apple Calendar and Reminders connected", "Slack connected" and "Fuse is running". Press Ctrl+C to stop it.

## 3. Run it in the background

```
npm run build
npm run launchd:install
```

Fuse now starts at login and restarts about 10 seconds after any crash. Logs are in `data/logs/` (`fuse.out.log` and `fuse.err.log`).

After you change the code or update the project, run `npm run build` and `npm run launchd:install` again. After you change only `.env`, run `npm run launchd:install` again to restart it.

To stop it for good: `npm run launchd:uninstall`.

## 4. Keep the Mac awake

Fuse cannot check your mail while the Mac sleeps. Open **System Settings → Energy** (or **Battery → Options** on a laptop) and turn on **Prevent automatic sleeping when the display is off** while on power. The screen can still turn off.

## 5. First-run checklist on the Mac

A few things can only be checked on a Mac, so please try each once:

- [ ] Ask Fuse on Telegram: "What's on my calendar today?" It should include events from Apple Calendar.
- [ ] Ask: "Remind me to call the dentist tomorrow at 10." A new reminder should appear in the Reminders app.
- [ ] Ask: "What's on my reminders?" The reminder you just made should be listed.
- [ ] If you connected Slack, ask a colleague to send you a direct message and to @mention you in a channel. You should get a Telegram alert for each within about 10 minutes.
- [ ] Run `npm run launchd:install`, restart the Mac, and check that Fuse answers on Telegram without you starting anything.

If one of these does not work, check `data/logs/fuse.err.log` and tell me what it says.

## Good to know

- **Recurring events in Apple Calendar.** Apple's scripting only lists the first occurrence of a recurring event that you created inside Apple Calendar itself. Recurring events from your Google calendar are not affected: Fuse reads those from Google.
- **Weekly memory tidy-up.** Every Sunday at 3 AM Fuse reviews the last week's notes and cleans up its long-term memory. It saves a dated copy of its memory files first (in `data/memory/backups/`) and tells you on Telegram what it changed.
- **Apple apps off.** Set `FUSE_APPLE=0` in `.env` to switch Apple Calendar and Reminders off.
