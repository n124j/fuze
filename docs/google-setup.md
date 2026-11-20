# Connecting Google to Fuse

You do this once. It takes about 10 minutes.

1. Go to <https://console.cloud.google.com/> and create a project (for example "Fuse").
2. **APIs & Services → Library**: enable **Gmail API**, **Google Calendar API**, **Google Tasks API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen**: choose **External**, fill in an app name and your email, and add yourself as a test user.
   Then press **Publish app** so the status is **In production**. Without this, Google expires your sign-in every 7 days.
   The app stays unverified (it is only for you), so Google shows a warning once; choose **Advanced → Go to Fuse (unsafe)**.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type **Desktop app**.
5. Copy the client ID and secret into `.env`:

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   FUSE_VIP_SENDERS=boss@example.com,family@example.com
   ```

6. Run `npm run google-auth`, open the link it prints, approve access, and wait for "Google connected".
7. Start Fuse with `npm run dev`. If Google ever stops working, Fuse tells you once on Telegram; run step 6 again.

Fuse asks for permission to read mail, save drafts, send mail (only after you tap Approve in Telegram), manage calendar events and tasks, and read Drive files.
The sign-in is stored in `data/google-token.json` on your machine only.
