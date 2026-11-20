# Connecting Slack to Fuse (optional)

Fuse can alert you on Telegram about Slack direct messages and @mentions, and search your Slack when you ask. It is read-only: it never posts, replies or reacts.
It takes about 5 minutes.

1. Go to <https://api.slack.com/apps> and choose **Create New App → From scratch**. Name it "Fuse" and pick your workspace.
2. Open **OAuth & Permissions**. Under **User Token Scopes** (not Bot Token Scopes), add one scope: `search:read`.
   Fuse uses your own user token because a bot cannot see your direct messages. That one scope can only search; it cannot write anything.
3. Click **Install to Workspace** and approve. Some workspaces need an admin to approve new apps; if so, ask them.
4. Copy the **User OAuth Token** (it starts with `xoxp-`) into `.env`:

   ```
   SLACK_USER_TOKEN=xoxp-...
   ```

5. Restart Fuse. It prints "Slack connected" at startup. The first check only records where your Slack is now, so you are not flooded with old messages.

If Slack ever stops working, Fuse tells you once a day on Telegram. Create a new token the same way and update `.env`.
