# Google Calendar Sync for Obsidian

Syncs your Google Calendar events as individual Obsidian notes with full YAML frontmatter properties. Use Obsidian Bases to build day, week, and month views — no DataView required.

## Features

- **Event-per-note sync** — each Google Calendar event becomes its own `.md` note
- **Full frontmatter** — date, start/end time, attendees, location, video link, and more as queryable properties
- **Multi-calendar support** — choose which calendars to sync; events organized into subfolders by calendar name
- **Configurable sync window** — sync N days back and forward (default: 30/30)
- **Two-way sync** — edit a note's date, time, title, or location and it syncs back to Google Calendar
- **Create events from Obsidian** — create a note from the event template and it appears in Google Calendar
- **Obsidian Bases ready** — filter `type = "calendar-event"` for day/week/month views
- **Auto-sync** — configurable background sync interval

## Requirements

- Obsidian v0.15.0 or later (desktop only)
- A Google account
- A Google Cloud project with the **Google Calendar API** enabled

---

## Setup

### 1. Google Cloud Console

#### Create a project and enable the Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top → **New Project** → give it any name (e.g. "Obsidian Sync") → **Create**
3. In the left sidebar go to **APIs & Services → Library**
4. Search for **Google Calendar API** → click it → click **Enable**
   - ⚠️ Do **not** enable the Tasks API — it is not used by this plugin

#### Configure the OAuth consent screen

5. Go to **APIs & Services → OAuth consent screen**
6. Choose your user type:
   - **Internal** *(recommended)* — available if your account is on Google Workspace (work or school). No warnings, no test user setup required. Select this if you see it.
   - **External** — required for personal Gmail accounts. You'll need to add yourself as a test user (step 9).
7. Click **Create** and fill in the required fields:
   - **App name**: anything (e.g. "Obsidian Calendar Sync")
   - **User support email**: your email
   - **Developer contact email**: your email
8. Click **Save and Continue** through the Scopes screen (no scopes to add here)
9. *(External only)* On the **Test users** screen click **+ Add Users** and add your Google account email
10. Click **Save and Continue** → **Back to Dashboard**

#### Create OAuth credentials

11. Go to **APIs & Services → Credentials**
12. Click **+ Create Credentials → OAuth client ID**
13. Application type: **Desktop app**
14. Name: anything (e.g. "Obsidian")
15. Click **Create**
16. Copy the **Client ID** and **Client Secret** — you'll paste these into the plugin settings

---

### 2. Plugin Configuration

1. In Obsidian, open **Settings → Google Calendar Sync**
2. Paste your **Client ID** and **Client Secret**
3. Click **Authorize** — your browser will open a Google sign-in page
4. Sign in with the test user account you added in step 9 above
5. Click through the Google consent screen
   - **Internal apps**: no warnings, just click Allow
   - **External apps in Testing mode**: you may see an "unverified app" warning — click **Advanced → Go to [app name] (unsafe)** to proceed
6. The browser will show "Authorization successful!" and you can return to Obsidian
7. Back in settings, click **Refresh calendar list** and toggle on the calendars you want to sync
8. Click **Sync now** to do your first sync

---

## Note Format

Each event creates a note like `Calendar/Work Calendar/Team Standup 2025-01-15.md`:

```yaml
---
type: calendar-event
calendar: Work Calendar
event-id: abc123_20250115T090000Z
title: Team Standup
date: 2025-01-15
start-time: "09:00"
end-time: "09:30"
all-day: false
location: Conference Room A
description: Daily standup
attendees:
  - alice@example.com
  - bob@example.com
organizer: manager@example.com
status: confirmed
video-link: "https://meet.google.com/..."
is-recurring: true
---

# Team Standup
```

---

## Obsidian Bases Setup

Create a Bases view on your `Calendar/` folder with `type = "calendar-event"` as the filter.

**Day view** — embed in a daily note, filter by date matching today:
```
type = "calendar-event" AND date = "2025-01-15"
```

**Week/Month view** — filter by date range, sort by `start-time` ascending.

The `type`, `date`, `start-time`, `calendar`, and `status` properties are the most useful for filtering and grouping.

---

## Two-Way Sync

**Editing existing events:** Change `title`, `date`, `start-time`, `end-time`, `location`, or `description` in a note's frontmatter and save. The plugin will push the update to Google Calendar within 2 seconds.

**Creating new events:** Use the **New Calendar Event** command (or the ribbon icon menu). A note opens with a pre-filled template — fill in at least `title`, `date`, and `calendar`, then save. The plugin creates the event in Google Calendar and writes the `event-id` back to the note.

---

## Code Structure

```
main.ts              — Plugin entry point, wires all services
types.ts             — Shared TypeScript interfaces and defaults
calendarFetcher.ts   — Google Calendar API: list calendars, fetch events
googleCalendarAPI.ts — Auth wrapper + createEvent/updateEvent
noteManager.ts       — Vault file CRUD, frontmatter serialization
templateEngine.ts    — {{variable}} substitution for note bodies
syncEngine.ts        — G→O sync orchestration, auto-sync timer
twoWaySync.ts        — O→G file watcher, new event creation
settingsTab.ts       — Plugin settings UI
oauthServer.ts       — Local OAuth 2.0 callback server
```

---

## Privacy & Security

- Authentication uses Google's official OAuth 2.0 flow
- Tokens are stored locally in Obsidian's plugin data (`data.json`)
- The plugin requests `calendar.events` (read/write events) and `calendar.readonly` (read calendar list)
- No data is sent anywhere other than Google's APIs

---

## Development

```bash
git clone <repo>
cd ObsidianGoogleCalendarSync
npm install

# Watch mode (dev)
npm run dev

# Production build
node esbuild.config.mjs production
```

Symlink into a vault for live development:
```bash
VAULT="/path/to/your/vault"
PLUGIN_DIR="$VAULT/.obsidian/plugins/google-calendar-sync"
mkdir -p "$PLUGIN_DIR"
ln -sf "$(pwd)/main.js"       "$PLUGIN_DIR/main.js"
ln -sf "$(pwd)/manifest.json" "$PLUGIN_DIR/manifest.json"
ln -sf "$(pwd)/styles.css"    "$PLUGIN_DIR/styles.css"
```

---

## Troubleshooting

**"Access blocked: app not verified"** — This only appears for External apps in Testing mode. Click **Advanced → Go to [app name] (unsafe)**. To avoid this entirely, set up your OAuth consent screen as **Internal** (requires a Google Workspace account).

**"Google Calendar: not authorized"** — Click Authorize in plugin settings. If you previously authorized with the old plugin version, you must re-authorize because the OAuth scopes changed.

**Events not appearing** — Check that the calendar is toggled on in settings, and that the event falls within your sync window (days back/forward).

**Two-way sync not working** — The plugin needs `calendar.events` write scope. If you authorized before v2.0, click Re-authorize in settings.
