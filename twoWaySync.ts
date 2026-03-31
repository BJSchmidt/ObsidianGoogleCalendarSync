import { App, Notice, TFile, normalizePath } from 'obsidian';
import { calendar_v3 } from 'googleapis';
import { GoogleCalendarAPI } from './googleCalendarAPI';
import { NoteManager } from './noteManager';
import { CalendarEventNote, FrontmatterSnapshot, GoogleCalendarSyncSettings } from './types';

// Frontmatter fields that, when changed, trigger a push to Google Calendar
const WATCHED_FIELDS: (keyof FrontmatterSnapshot)[] = [
	'title', 'date', 'startTime', 'endTime', 'allDay', 'endDate', 'location', 'description',
];

// Build a valid ISO datetime string, zero-padding the hour if needed
function toDateTime(date: string, time: string): string {
	const [h = '00', m = '00'] = time.split(':');
	return `${date}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00`;
}

// Normalize a frontmatter date value to "YYYY-MM-DD" string.
// Obsidian's YAML 1.1 parser reads bare dates like "2026-03-02" as JavaScript Date objects.
function fmDate(val: unknown): string {
	if (!val) return '';
	if (val instanceof Date) return val.toISOString().slice(0, 10);
	const s = String(val).trim();
	// If it somehow arrived as a full ISO timestamp, extract just the date part
	if (s.length > 10 && (s.includes('T') || s.includes(' '))) return s.slice(0, 10);
	return s;
}

// Normalize a frontmatter time value to 24hr "HH:MM" string for the Google API.
// Handles:
//   - Strings in 24hr format ("09:00", "13:30") — returned as-is
//   - Strings in 12hr format ("9:00 AM", "1:30 PM") — converted to 24hr
//   - Numbers: Obsidian's YAML 1.1 parser reads unquoted "10:00" as integer 600 (sexagesimal)
function fmTime(val: unknown): string | null {
	if (val === null || val === undefined) return null;
	if (typeof val === 'string') {
		const s = val.trim();
		if (!s) return null;
		// 12hr format: "9:00 AM", "12:30 PM", etc.
		const match12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
		if (match12) {
			let h = parseInt(match12[1], 10);
			const m = match12[2];
			const period = match12[3].toUpperCase();
			if (period === 'AM') {
				if (h === 12) h = 0;
			} else {
				if (h !== 12) h += 12;
			}
			return `${String(h).padStart(2, '0')}:${m}`;
		}
		return s;
	}
	if (typeof val === 'number' && val >= 0) {
		const h = Math.floor(val / 60);
		const m = val % 60;
		return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
	}
	return null;
}

// Convert a raw Google Calendar API event to snapshot-comparable fields
function googleEventToSnapshot(raw: calendar_v3.Schema$Event): Partial<FrontmatterSnapshot> {
	const isAllDay = !raw.start?.dateTime;
	const dateStr = raw.start?.date ?? raw.start?.dateTime?.slice(0, 10) ?? '';
	let startTimeStr: string | null = null;
	let endTimeStr: string | null = null;
	if (!isAllDay && raw.start?.dateTime) startTimeStr = raw.start.dateTime.slice(11, 16);
	if (!isAllDay && raw.end?.dateTime) endTimeStr = raw.end.dateTime.slice(11, 16);

	let endDate: string | null = null;
	if (isAllDay && raw.end?.date) {
		const endD = new Date(raw.end.date + 'T00:00:00');
		endD.setDate(endD.getDate() - 1);
		const adjusted = endD.toISOString().slice(0, 10);
		if (adjusted !== dateStr) endDate = adjusted;
	}

	return {
		title: raw.summary || '',
		date: dateStr,
		startTime: startTimeStr,
		endTime: endTimeStr,
		allDay: isAllDay,
		endDate,
		location: raw.location || '',
		description: raw.description || '',
		updated: raw.updated || '',
	};
}

// Minimum required fields to create a new Google Calendar event from a note.
// Only 'date' is strictly required — title falls back to the filename, and
// cal-calendar falls back to the configured defaultCalendarId.
const REQUIRED_NEW_EVENT_FIELDS = ['date'];

export class TwoWaySyncHandler {
	// eventId -> last-known frontmatter values (echo-loop prevention)
	private snapshots = new Map<string, FrontmatterSnapshot>();
	// file path -> debounce timer handle
	private debounceTimers = new Map<string, number>();
	private readonly DEBOUNCE_MS = 4000;
	// Set true after the first G→O sync completes; O→G watching is blocked until then
	private syncReady = false;
	// Set true in destroy() to abort any async work that is still mid-flight
	private destroyed = false;

	constructor(
		private app: App,
		private api: GoogleCalendarAPI,
		private noteManager: NoteManager,
		private getSettings: () => GoogleCalendarSyncSettings,
		private getSyncEngineIsSyncing: () => boolean
	) {}

	// Scan all existing event notes and populate the snapshot cache
	async initialize(): Promise<void> {
		this.snapshots.clear();
		const settings = this.getSettings();
		const folder = this.app.vault.getAbstractFileByPath(
			normalizePath(settings.syncFolder)
		);
		if (!folder) return;

		const allFiles = this.app.vault.getMarkdownFiles();
		const syncFolderPrefix = normalizePath(settings.syncFolder) + '/';

		for (const file of allFiles) {
			if (!file.path.startsWith(syncFolderPrefix)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (!fm || fm['cal-type'] !== 'calendar-event') continue;
			const eventId = fm['cal-event-id'];
			if (!eventId || typeof eventId !== 'string' || !eventId.trim()) continue;

			this.snapshots.set(eventId, {
				title: fm['title'] ?? '',
				date: fmDate(fm['date']),
				startTime: fmTime(fm['startTime']),
				endTime: fmTime(fm['endTime']),
				allDay: fm['allDay'] === true || fm['allDay'] === 'true',
				endDate: fmDate(fm['endDate']) || null,
				location: fm['cal-location'] ?? '',
				description: fm['cal-description'] ?? '',
				updated: fm['cal-updated'] ?? '',
			});
		}
	}

	// Called by SyncEngine after writing a note to prevent echo-loops
	updateSnapshot(eventId: string, snapshot: FrontmatterSnapshot): void {
		this.snapshots.set(eventId, snapshot);
	}

	removeSnapshot(eventId: string): void {
		this.snapshots.delete(eventId);
	}

	// Unblock O→G watching; called by main.ts after the first G→O sync resolves
	setSyncReady(value: boolean): void {
		this.syncReady = value;
	}

	// Scan all files in the sync folder for ones that have a date but no cal-event-id.
	// This catches events created by tools like Full Calendar that don't go through
	// our create/modify hooks (e.g. they existed before the plugin loaded).
	async scanForUnsyncedFiles(): Promise<void> {
		const syncFolderPrefix = normalizePath(this.getSettings().syncFolder) + '/';
		const allFiles = this.app.vault.getMarkdownFiles();

		for (const file of allFiles) {
			if (this.destroyed) return;
			if (!file.path.startsWith(syncFolderPrefix)) continue;

			const content = await this.app.vault.read(file);
			const fm = this.noteManager.parseFrontmatter(content) as Record<string, unknown>;
			if (!fm || !fm['date']) continue;

			const eventId = fm['cal-event-id'] as string | undefined;
			if (eventId && eventId.trim()) continue; // Already synced

			await this.handleNewEvent(file, fm);
		}
	}

	// Entry point for vault 'modify' events
	handleFileModify(file: TFile): void {
		console.log('[GCal] handleFileModify', file.path, 'syncReady:', this.syncReady, 'isWriting:', this.noteManager.isWriting, 'inFolder:', this.isInSyncFolder(file));
		if (!this.syncReady) return;
		if (this.noteManager.isWriting) return;
		if (!this.isInSyncFolder(file)) return;

		this.debounce(file.path, () => this.processModification(file));
	}

	// Entry point for vault 'delete' events — push deletion to Google if configured
	handleFileDelete(file: TFile, frontmatter: Record<string, unknown>): void {
		if (!this.syncReady) return;
		if (this.noteManager.isWriting) return;

		const behavior = this.getSettings().onNoteDeleteBehavior;
		if (behavior === 'ignore') return;

		const eventId = frontmatter['cal-event-id'] as string | undefined;
		const calendarId = frontmatter['cal-calendar-id'] as string | undefined;
		if (!eventId?.trim() || !calendarId?.trim()) return;

		const title = (frontmatter['title'] as string) ?? '(unknown)';
		this.processDelete(eventId, calendarId, title, behavior);
	}

	private async processDelete(
		eventId: string,
		calendarId: string,
		title: string,
		behavior: 'cancel' | 'delete'
	): Promise<void> {
		if (this.destroyed) return;
		if (this.getSyncEngineIsSyncing()) return;

		try {
			if (behavior === 'delete') {
				await this.api.deleteEvent(calendarId, eventId);
			} else {
				await this.api.cancelEvent(calendarId, eventId);
			}
			this.snapshots.delete(eventId);
			this.notify(`${behavior === 'delete' ? 'Deleted' : 'Cancelled'} "${title}" in Google Calendar.`);
		} catch (err: any) {
			this.notify(`Failed to ${behavior} "${title}" in Google Calendar: ${err?.message ?? err}`);
			console.error(`Two-way sync delete failed. calendarId:`, calendarId, 'eventId:', eventId, err);
		}
	}

	// Entry point for vault 'create' events (user-created notes without event-id)
	handleFileCreate(file: TFile): void {
		console.log('[GCal] handleFileCreate', file.path, 'syncReady:', this.syncReady, 'isWriting:', this.noteManager.isWriting, 'inFolder:', this.isInSyncFolder(file));
		if (!this.syncReady) return;
		if (this.noteManager.isWriting) return;
		if (!this.isInSyncFolder(file)) return;
		if (file.extension !== 'md') return;

		// Debounce: wait for user to finish filling in the template
		this.debounce(file.path, () => this.processNewFile(file));
	}

	private async processModification(file: TFile): Promise<void> {
		console.log('[GCal] processModification', file.path, 'destroyed:', this.destroyed, 'isSyncing:', this.getSyncEngineIsSyncing());
		if (this.destroyed) return;
		if (this.getSyncEngineIsSyncing()) return;

		// Read and parse frontmatter directly from file content rather than
		// relying on the metadata cache (which updates asynchronously).
		const content = await this.app.vault.read(file);
		const fm = this.noteManager.parseFrontmatter(content) as Record<string, unknown>;
		console.log('[GCal] processModification fm:', JSON.stringify(fm));
		// Accept files that are already marked as calendar events OR any file in the
		// sync folder that has a date property (e.g. events created by Full Calendar).
		if (!fm || (fm['cal-type'] !== 'calendar-event' && !fm['date'])) {
			console.log('[GCal] processModification: skipping - no cal-type and no date');
			return;
		}

		const eventId = fm['cal-event-id'] as string | undefined;
		if (!eventId || !eventId.trim()) {
			// No event-id — treat as a new event to push
			await this.handleNewEvent(file, fm);
			return;
		}

		const snapshot = this.snapshots.get(eventId);
		if (!snapshot) return; // Not in our index; skip

		// Build current state from frontmatter
		const current: FrontmatterSnapshot = {
			title: (fm['title'] as string) ?? '',
			date: fmDate(fm['date']),
			startTime: fmTime(fm['startTime']),
			endTime: fmTime(fm['endTime']),
			allDay: fm['allDay'] === true || fm['allDay'] === 'true',
			endDate: fmDate(fm['endDate']) || null,
			location: (fm['cal-location'] as string) ?? '',
			description: (fm['cal-description'] as string) ?? '',
			updated: (fm['cal-updated'] as string) ?? '',
		};

		// Determine which fields the user changed locally (vs last-known snapshot)
		const localChanges = WATCHED_FIELDS.filter(
			field => String(current[field] ?? '') !== String(snapshot[field] ?? '')
		);
		if (localChanges.length === 0) return;

		// Push-validity guard: only push when the event is in a complete, valid state.
		if (current.startTime || !current.allDay) {
			if (!current.endTime || !current.date) return;
		} else {
			if (!current.date) return;
		}

		const calendarId: string = (fm['cal-calendar-id'] as string) || this.getSettings().defaultCalendarId;
		const timezone = (fm['cal-timezone'] as string) || Intl.DateTimeFormat().resolvedOptions().timeZone;

		// Field-level merge: if Google also changed since our snapshot, fetch the
		// current Google state and merge non-overlapping changes.
		let merged = current;
		if (current.updated && snapshot.updated && current.updated < snapshot.updated) {
			try {
				const googleRaw = await this.api.getEvent(calendarId, eventId);
				const googleState = googleEventToSnapshot(googleRaw);

				// Determine which fields Google changed (vs our snapshot)
				const googleChanges = WATCHED_FIELDS.filter(
					field => String(googleState[field] ?? '') !== String(snapshot[field] ?? '')
				);

				// For fields changed by both sides, Google wins.
				// For fields only changed locally, keep local.
				// For fields only changed by Google, accept Google.
				const conflictFields = localChanges.filter(f => googleChanges.includes(f));
				if (conflictFields.length > 0) {
					this.notify(
						`Sync conflict on "${fm['title']}": Google wins for ${conflictFields.join(', ')}.`,
						8000
					);
				}

				// Build merged state: start from current (user's version)
				merged = { ...current };
				// Apply Google's changes for fields not locally modified, and for conflicts
				for (const field of googleChanges) {
					if (!localChanges.includes(field) || conflictFields.includes(field)) {
						(merged as any)[field] = googleState[field];
					}
				}

				// If only Google changed and no local-only changes remain, skip push
				const localOnlyChanges = localChanges.filter(f => !conflictFields.includes(f));
				if (localOnlyChanges.length === 0 && conflictFields.length === 0) {
					// Google changed but user didn't — no push needed
					this.updateSnapshot(eventId, { ...merged, updated: googleRaw.updated ?? snapshot.updated });
					return;
				}
			} catch (err) {
				// Can't fetch Google state — fall back to discarding local change
				this.notify(`Sync conflict on "${fm['title']}": couldn't fetch Google version. Local change discarded.`);
				return;
			}
		}

		const patch = this.buildPatch(merged, fm, timezone);

		try {
			const updated = await this.api.updateEvent(calendarId, eventId, patch);
			this.notify(`Updated "${merged.title}" in Google Calendar.`);
			this.updateSnapshot(eventId, {
				...merged,
				updated: updated.updated ?? merged.updated,
			});
			// Write the new updated timestamp back to the note silently
			if (updated.updated && updated.updated !== fm['cal-updated']) {
				const rawContent = await this.app.vault.read(file);
				const body = this.noteManager.extractBody(rawContent);
				const fmObj = this.noteManager.parseFrontmatter(rawContent);
				fmObj['cal-updated'] = updated.updated;
				const newContent = this.noteManager.buildNoteContent(fmObj, body);
				this.noteManager.beginWrite();
				try {
					await this.app.vault.modify(file, newContent);
				} finally {
					this.noteManager.endWrite();
				}
			}
			// Rename the file if title or date changed (mirrors the rename in updateEventNote)
			if (localChanges.includes('title') || localChanges.includes('date')) {
				const calendarName = (fm['cal-calendar'] as string) ?? '';
				const desiredPath = this.noteManager.getNotePathForEvent({
					title: merged.title,
					date: merged.date,
					calendarName,
					eventId,
				} as any);
				if (desiredPath !== file.path) {
					const oldPath = file.path;
					const desiredFolder = desiredPath.substring(0, desiredPath.lastIndexOf('/'));
					await this.noteManager.ensureFolderExists(desiredFolder);
					this.noteManager.beginWrite();
					try {
						await this.app.fileManager.renameFile(file, desiredPath);
						this.noteManager.updateIndexPath(oldPath, desiredPath);
					} finally {
						this.noteManager.endWrite();
					}
				}
			}
		} catch (err: any) {
			const startDbg = JSON.stringify(patch.start);
			const endDbg = JSON.stringify(patch.end);
			this.notify(`Failed to update "${fm['title']}": ${err?.message ?? err} | start=${startDbg} end=${endDbg}`, 12000);
			console.error('Two-way sync update failed. calendarId:', calendarId, 'eventId:', eventId, 'patch:', patch, err);
		}
	}

	private async processNewFile(file: TFile): Promise<void> {
		if (this.getSyncEngineIsSyncing()) return;

		const content = await this.app.vault.read(file);
		const fm = this.noteManager.parseFrontmatter(content) as Record<string, unknown>;
		// Accept files that are already marked as calendar events OR any file in the
		// sync folder that has a date property (e.g. events created by Full Calendar).
		if (!fm || (fm['cal-type'] !== 'calendar-event' && !fm['date'])) return;

		const eventId: string | undefined = fm['cal-event-id'] as string | undefined;
		if (eventId && eventId.trim()) return; // Already has event-id; not a new event

		await this.handleNewEvent(file, fm);
	}

	private async handleNewEvent(file: TFile, fm: Record<string, unknown>): Promise<void> {
		console.log('[GCal] handleNewEvent', file.path);
		if (this.destroyed) return;

		// Validate required fields
		const missing = REQUIRED_NEW_EVENT_FIELDS.filter(f => {
			const val = fm[f];
			return !val || (typeof val === 'string' && !val.trim());
		});
		if (missing.length > 0) {
			console.log('[GCal] handleNewEvent: missing fields', missing);
			return; // Not ready yet; will retry on next save
		}

		const title = String(fm['title'] ?? '') || file.basename;
		const date = fmDate(fm['date']);
		const calendarFieldValue = String(fm['cal-calendar'] ?? '');

		// Resolve calendar ID: match 'cal-calendar' field against known names or IDs,
		// then fall back to the parent folder name, then to defaultCalendarId.
		let calendarId = this.getSettings().defaultCalendarId;
		if (calendarFieldValue && calendarFieldValue !== calendarId) {
			try {
				const calendars = await this.api.fetcher.listCalendars();
				const match = calendars.find(
					c => c.name === calendarFieldValue || c.id === calendarFieldValue
				);
				if (match) calendarId = match.id;
			} catch {
				// API unavailable; will try folder-name fallback below
			}
		}

		// If still unresolved, try matching the file's parent folder name to a calendar
		if (!calendarId) {
			const folderName = file.parent?.name ?? '';
			const cachedCalendars = this.getSettings().cachedCalendars ?? [];
			const folderMatch = cachedCalendars.find(c => c.name === folderName);
			if (folderMatch) calendarId = folderMatch.id;
		}

		console.log('[GCal] handleNewEvent: resolved calendarId:', calendarId, 'folderName:', file.parent?.name);
		if (!calendarId) {
			this.notify(`Cannot sync "${title}": no calendar found. Set cal-calendar in the note or configure a default calendar.`);
			return;
		}
		if (this.destroyed) return;

		// Build the Google event resource
		const startTime = fmTime(fm['startTime']);
		const endTime = fmTime(fm['endTime']);
		const allDay = !startTime;

		const event: calendar_v3.Schema$Event = {
			summary: title,
			location: (fm['cal-location'] as string) || undefined,
			description: (fm['cal-description'] as string) || undefined,
		};

		if (allDay) {
			event.start = { date };
			const endDate = (fm['endDate'] as string) || date;
			// Google expects exclusive end date for all-day events, so add 1 day
			const endD = new Date(endDate + 'T00:00:00');
			endD.setDate(endD.getDate() + 1);
			event.end = { date: endD.toISOString().slice(0, 10) };
		} else {
			const tz = (fm['cal-timezone'] as string) || Intl.DateTimeFormat().resolvedOptions().timeZone;
			const startDt = startTime ? toDateTime(date, startTime) : `${date}T00:00:00`;
			const endDt = endTime ? toDateTime(date, endTime) : startDt;
			event.start = { dateTime: startDt, timeZone: tz };
			event.end = { dateTime: endDt, timeZone: tz };
		}

		const attendees = fm['cal-attendees'];
		if (Array.isArray(attendees)) {
			event.attendees = (attendees as string[])
				.filter((e: string) => e && e.trim())
				.map((e: string) => ({ email: e }));
		}

		const created = await this.api.createEvent(calendarId, event);
		if (!created || !created.id) {
			this.notify(`Failed to create "${title}" in Google Calendar.`);
			return;
		}

		// Resolve calendar name for the note
		const cachedCalendars = this.getSettings().cachedCalendars ?? [];
		const calendarName = cachedCalendars.find(c => c.id === calendarId)?.name ?? calendarId;
		const tz = (fm['cal-timezone'] as string) || Intl.DateTimeFormat().resolvedOptions().timeZone;

		// Build a full CalendarEventNote so updateEventNote writes all cal-* properties back
		const eventNote: CalendarEventNote = {
			eventId: created.id,
			calendarId,
			calendarName,
			recurrenceMasterId: null,
			title,
			date,
			startTime: startTime ?? null,
			endTime: endTime ?? null,
			allDay,
			endDate: fmDate(fm['endDate']) || null,
			location: (fm['cal-location'] as string) || '',
			description: (fm['cal-description'] as string) || '',
			attendees: Array.isArray(fm['cal-attendees'])
				? (fm['cal-attendees'] as string[]).filter(e => e?.trim())
				: [],
			organizer: (fm['cal-organizer'] as string) || '',
			status: 'confirmed',
			videoLink: (fm['cal-video-link'] as string) || '',
			eventLink: created.htmlLink ?? '',
			isRecurring: false,
			timezone: tz,
			created: created.created ?? new Date().toISOString(),
			updated: created.updated ?? new Date().toISOString(),
		};

		await this.noteManager.updateEventNote(file, eventNote);

		this.updateSnapshot(created.id, {
			title,
			date,
			startTime: startTime ?? null,
			endTime: endTime ?? null,
			allDay,
			endDate: fmDate(fm['endDate']) || null,
			location: eventNote.location,
			description: eventNote.description,
			updated: eventNote.updated,
		});

		this.notify(`Created "${title}" in Google Calendar.`);
	}

	private buildPatch(current: FrontmatterSnapshot, fm: Record<string, unknown>, timezone: string): calendar_v3.Schema$Event {
		const patch: calendar_v3.Schema$Event = {};

		if (current.title) patch.summary = current.title;
		if (current.location !== undefined) patch.location = current.location || undefined;
		if (current.description !== undefined) patch.description = current.description || undefined;

		if (current.date) {
			if (current.allDay) {
				const endDate = current.endDate || current.date;
				const endD = new Date(endDate + 'T00:00:00');
				endD.setDate(endD.getDate() + 1);
				// Null out dateTime for timed → all-day conversions
				patch.start = { date: current.date, dateTime: null };
				patch.end = { date: endD.toISOString().slice(0, 10), dateTime: null };
			} else {
				const startDt = current.startTime
					? toDateTime(current.date, current.startTime)
					: `${current.date}T00:00:00`;
				const endDt = current.endTime
					? toDateTime(current.date, current.endTime)
					: startDt;
				// Null out date for all-day → timed conversions
				patch.start = { date: null, dateTime: startDt, timeZone: timezone };
				patch.end = { date: null, dateTime: endDt, timeZone: timezone };
			}
		}

		return patch;
	}

	private isInSyncFolder(file: TFile): boolean {
		const syncFolder = normalizePath(this.getSettings().syncFolder);
		return file.path.startsWith(syncFolder + '/');
	}

	private debounce(key: string, fn: () => void): void {
		const existing = this.debounceTimers.get(key);
		if (existing !== undefined) window.clearTimeout(existing);
		const handle = window.setTimeout(() => {
			this.debounceTimers.delete(key);
			fn();
		}, this.DEBOUNCE_MS);
		this.debounceTimers.set(key, handle);
	}

	private notify(message: string, timeout?: number): void {
		if (!this.getSettings().showPushNotifications) return;
		new Notice(message, timeout);
	}

	destroy(): void {
		this.destroyed = true;
		for (const handle of this.debounceTimers.values()) {
			window.clearTimeout(handle);
		}
		this.debounceTimers.clear();
	}
}
