# InboxPro

A unified LinkedIn + Sales Navigator inbox. Local-first: your data stays on your machine, everything runs at `localhost:3030`.

## Quick start (per teammate, ~5 min)

### 1. Accept the GitHub invite

You'll get an email from GitHub. Click **Accept invitation**.

### 2. Download and run `Get InboxPro.command`

Jacob will send you a link to this file. Download it, then:

- **Double-click** it to run
- If macOS blocks it: **right-click → Open → Open** (one-time prompt, never again after this)

It handles everything automatically:
- Installs Homebrew + Node.js if missing
- Opens your browser to log into GitHub (just clicking, no typing)
- Downloads InboxPro to `~/Documents/inbox-app`
- Builds and starts the server at `localhost:3030`
- Opens Chrome to the extension page

### 3. Load the Chrome extension (3 clicks)

In the `chrome://extensions` tab that opened:

1. Toggle **Developer mode** (top-right)
2. Click **Load unpacked**
3. Select the `extension` folder inside your `inbox-app` directory

### 4. Follow the in-app wizard

Switch to the `localhost:3030` tab. The onboarding wizard handles everything else:

- Auto-detects the extension you just loaded
- Asks you to open LinkedIn (and optionally Sales Navigator) in tabs
- Runs an API-driven sync to pull all your conversations + messages
- Optional: upload your LinkedIn data export for richer contact info
- Optional: paste an Anthropic API key for AI features (Draft, Improve, Smart Search)

If you use **Sales Navigator**, open `linkedin.com/sales` after the wizard finishes and click the floating "Sync this SN inbox" button — it does the equivalent sync for SN threads.

## How it works

Three concurrent sync layers keep your inbox fresh without you doing anything:

| Layer | When it runs | Latency |
|---|---|---|
| **Bridge poll** | InboxPro tab open | ~10s LinkedIn, ~10s SN |
| **chrome.alarms** | Always, even browser closed | 5 min LinkedIn, 3 min SN |
| **Action trigger** | When you reply from SN | sub-5s |

For the initial sync specifically: we hit LinkedIn's and SN's APIs directly via the Chrome extension's service worker (using your cookies + CSRF token from your existing browser session). No scrolling, no UI dependency, no scraping. LinkedIn sees normal API traffic from your own browser.

## Updating

When Jacob pushes a new version, open Terminal and run:

```bash
cd inbox-app
git pull
npm run update
```

That pulls the latest code, applies any new database migrations, and restarts the server. Your conversations and data are never touched.

## Privacy

- **100% local.** `dev.db` is a SQLite file in your `inbox-app` folder. Your data never leaves your machine.
- **LinkedIn cookies** stay in Chrome's storage. The extension reads them only to authenticate API calls from your own browser.
- **Anthropic API key** (if you add one) is stored locally and only used for the AI feature endpoints; calls go directly from your machine to `api.anthropic.com`.

## Features

- Full LinkedIn + Sales Nav conversation history with contacts' names, headlines, avatars, profile URLs
- Labels (Hot Lead, Follow Up, Client, etc.)
- Snippets with `/shortcut` syntax
- Snooze, archive, mark read/unread, star — all mirror back to LinkedIn / Sales Nav
- Reply from InboxPro (sends through real LinkedIn / SN API)
- Typing indicator (LinkedIn only — Sales Nav's typing runs through a SharedWorker we can't reach)
- Search across all conversations + AI semantic search
- AI features: Draft Reply, Improve Draft, auto-classify cold outreach
- Analytics: response rate, avg reply time, daily volume
- Outbound Queue: hot / overdue / going cold / stale categorization
- Desktop notifications for new messages
- Light + dark themes, user-resizable conv list column

## Troubleshooting

**"Extension not detected"** in the wizard — reload it at `chrome://extensions` and hard-refresh `localhost:3030` (Cmd+Shift+R).

**Installer won't run / Gatekeeper blocks it** — right-click `Install InboxPro.command` → Open → Open in the dialog. Or in System Settings → Privacy & Security, scroll down and click **Allow Anyway**.

**Port 3030 already in use** — the installer auto-kills anything on that port before starting. If it persists: `kill $(lsof -ti :3030)` in Terminal, then run the installer again.

**Sync runs but no messages appear** — open the **Diagnostics** page in the InboxPro sidebar. It shows DB stats, a live sync-event log, and a Force-refresh button.

**Need to wipe everything** — Diagnostics → **Reset DB**. Requires typing `RESET` to confirm; destroys all conversations and messages but leaves your API key and labels.

## Manual install (if you prefer the terminal)

```bash
gh repo clone jacobbrachna/inbox-app ~/Documents/inbox-app
cd ~/Documents/inbox-app
bash setup.sh              # installs deps, runs DB migrations
npm run restart            # builds + starts production server on :3030
```

Then load the Chrome extension as in Step 3 above.

## License

Internal use only.
