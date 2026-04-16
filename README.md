# Google Calendar Sync for Obsidian

Syncs your Google Calendar events as individual Obsidian notes with full YAML frontmatter. Use Obsidian Bases to build interactive calendar views — no DataView required.

## Features

- **Event-per-note sync** — each Google Calendar event becomes its own `.md` note in `Calendar/{CalendarName}/`
- **Full frontmatter** — date, start/end time, attendees, location, video link, and more as queryable properties
- **Multi-calendar support** — choose which calendars to sync
- **Vault-wide calendar events** — any note anywhere in your vault with `calendar` + `date` properties becomes a calendar event; the plugin creates it in Google and keeps it in sync
- **Two-way sync** — edit a note's title, date, time, or location and it syncs back to Google Calendar within a few seconds
- **Create events from Obsidian** — use the **New Calendar Event** command, click a time slot in a calendar view, or use **Add to Calendar** to schedule any existing note
- **Interactive Bases calendar views** — built-in Month, Week, 7-day, 14-day, and 2-week views powered by TUI Calendar; click to edit, drag to reschedule, click empty slot to create
- **Auto-sync** — configurable background sync interval
- **Configurable sync window** — sync N days back and forward (default: 30/30)

## Requirements

- Obsidian v1.8 or later (desktop only; requires Obsidian Bases)
- A Google account
- A Google Cloud project with the **Google Calendar API** enabled

---

## Setup

### 1. Google Cloud Console

#### Create a project and enable the Calendar API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown → **New Project** → give it any name (e.g. "Obsidian Sync") → **Create**
3. Go to **APIs & Services → Library**, search for **Google Calendar API** → **Enable**

#### Configure the OAuth consent screen

4. Go to **APIs & Services → OAuth consent screen**
5. Choose your user type:
   - **Internal** *(recommended)* — available if your account is on Google Workspace. No warnings, no test user setup required.
   - **External** — required for personal Gmail accounts. Add yourself as a test user (step 8).
6. Click **Create**, fill in App name, User support email, and Developer contact email
7. Click **Save and Continue** through the Scopes screen
8. *(External only)* On **Test users**, click **+ Add Users** and add your Google account email

#### Create OAuth credentials

9. Go to **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
10. Application type: **Desktop app**
11. Click **Create**, then copy the **Client ID** and **Client Secret**

---

### 2. Plugin Configuration

1. Open **Settings → Google Calendar Sync**
2. Paste your **Client ID** and **Client Secret**
3. Click **Authorize** — sign in and allow access in the browser that opens
4. Back in settings, click **Refresh calendar list** and toggle on the calendars you want to sync
5. Click **Sync now** to run the first sync

---

## Note Format

Events synced from Google land in `Calendar/{CalendarName}/{title}.md`. If two events share the same title, the date is appended to the second one (`{title} {date}.md`).

```yaml
---
cal-type: calendar-event
calendar: Work Calendar
cal-event-id: abc123_20250115T090000Z
title: Team Standup
date: 2025-01-15
startTime: "09:00"
endTime: "09:30"
allDay: false
cal-location: Conference Room A
cal-description: Daily standup
cal-attendees:
  - alice@example.com
  - bob@example.com
cal-organizer: manager@example.com
cal-status: confirmed
cal-video-link: "https://meet.google.com/..."
cal-is-recurring: true
---

# Team Standup
```

---

## Vault-Wide Calendar Events

Any note in your vault — not just notes in the Calendar folder — can become a Google Calendar event. Just add `calendar` and `date` to its frontmatter:

```yaml
---
title: Doctor Appointment
date: 2025-03-20
calendar: Personal
startTime: "14:00"
endTime: "15:00"
---
```

The plugin will create the event in Google Calendar on the next save, write back the `cal-event-id`, and keep the note in sync. The note's filename and location are never changed by the plugin — only the frontmatter is managed.

---

## Calendar Views

The plugin registers five Bases view types:

| View | ID |
|------|----|
| Month Calendar | `cal-month` |
| Week Calendar | `cal-week` |
| 7-Day Lookahead | `cal-7day` |
| 14-Day Lookahead | `cal-14day` |
| 2-Week Calendar | `cal-2week` |

Add one of these views to any `.base` file. In the view options, set the **Calendar name property** to `calendar`.

**Interactions:**
- **Click an event** — opens the edit modal, with shortcut buttons to open the underlying note or jump to the event in Google Calendar
- **Drag or resize an event** — reschedules it and syncs to Google
- **Click an empty time slot** — opens the create modal with the date/time pre-filled

The edit modal also handles notes that aren't linked to a calendar (e.g. tasks with just a `date`) — the calendar dropdown shows **(Not on calendar)** so you can either leave it as a plain dated note or assign it to a calendar to start syncing.

### Ribbon Button

Enable **Show calendar ribbon button** in settings and set **Calendar base path** to open your `.base` file directly from the ribbon. The **Open Calendar** command in the command palette always works regardless of this setting.

---

## Two-Way Sync

**Editing existing events:** Change `title`, `date`, `startTime`, `endTime`, `cal-location`, or `cal-description` in a note's frontmatter and save. The plugin pushes the update to Google Calendar within a few seconds.

**Creating new events from Obsidian:**
- Use the **New Calendar Event** command to create a new note + event in one step, or
- Use **Add to Calendar** on any open note to schedule it — opens a form pre-filled with the note's title, writes calendar properties into the existing frontmatter, and syncs to Google on the next cycle, or
- Click a time slot in a calendar view, or
- Add `calendar` + `date` to any existing note manually, or
- Duplicate `Resources/Templates/Calendar Event.md` and fill in the properties, or
- Use Templater's **Insert template** or **Create note from template** commands with `Resources/Templates/Calendar Event.md`

In all cases the plugin creates the event in Google and writes `cal-event-id` back to the note.

**Add to Calendar** also handles notes that are already calendar events:
- If the note has a `cal-event-id` → opens the Edit Calendar Event form
- If the note has `calendar` + `date` but no `cal-event-id` → shows a notice that it will sync automatically

---

## Code Structure

```
main.ts              — Plugin entry point, wires all services
types.ts             — Shared TypeScript interfaces and defaults
calendarFetcher.ts   — Google Calendar API: list calendars, fetch events
googleCalendarAPI.ts — Auth wrapper + createEvent/updateEvent
noteManager.ts       — Vault file CRUD, frontmatter serialization, event index
templateEngine.ts    — {{variable}} substitution for note bodies
syncEngine.ts        — G→O sync orchestration, auto-sync timer
twoWaySync.ts        — O→G file watcher, new event creation, conflict resolution
settingsTab.ts       — Plugin settings UI
basesCalendarView.ts — TUI Calendar Bases view implementations
createEventModal.ts  — Create/edit event modal
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

# Production build
node esbuild.config.mjs production

# Type check only
npx tsc -noEmit -skipLibCheck
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

**"Access blocked: app not verified"** — Click **Advanced → Go to [app name] (unsafe)**. To avoid this, set up your OAuth consent screen as **Internal** (requires Google Workspace).

**"Google Calendar: not authorized"** — Click Authorize in plugin settings.

**Events not appearing** — Check that the calendar is toggled on in settings and the event falls within your sync window.

**Two-way sync not working** — The plugin needs `calendar.events` write scope. If you authorized with an older version, click Re-authorize in settings.

**Table view header broken after using calendar view** — Update to the latest version; this was fixed by removing the `cal-view-container` class on view unload.
