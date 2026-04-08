import { App, Notice } from 'obsidian';
import { GoogleCalendarAPI } from './googleCalendarAPI';
import { NoteManager } from './noteManager';
import { TemplateEngine } from './templateEngine';
import { CalendarEventNote, FrontmatterSnapshot, GoogleCalendarSyncSettings, SyncResult } from './types';

export class SyncEngine {
	private isSyncing = false;
	private intervalHandle: number | null = null;
	// Called after every note create/update so TwoWaySyncHandler can register the snapshot
	onNoteUpserted?: (eventId: string, snapshot: FrontmatterSnapshot) => void;

	constructor(
		private app: App,
		private api: GoogleCalendarAPI,
		private noteManager: NoteManager,
		private templateEngine: TemplateEngine,
		private getSettings: () => GoogleCalendarSyncSettings,
		private saveSettings: () => Promise<void>
	) {}

	get syncing(): boolean {
		return this.isSyncing;
	}

	async runForceResync(): Promise<SyncResult> {
		// Clear all per-calendar sync tokens to force a full time-window fetch
		const settings = this.getSettings();
		settings.syncTokens = {};
		await this.saveSettings();
		return this.runSync(true);
	}

	async runSync(forceUpdate = false): Promise<SyncResult> {
		if (this.isSyncing) {
			new Notice('Google Calendar sync already in progress');
			return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] };
		}

		const settings = this.getSettings();
		if (!settings.googleAccessToken) {
			new Notice('Google Calendar: not authorized. Please authorize in plugin settings.');
			return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] };
		}
		if (settings.enabledCalendars.length === 0) {
			new Notice('Google Calendar: no calendars selected. Configure calendars in plugin settings.');
			return { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] };
		}

		this.isSyncing = true;
		const result: SyncResult = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] };

		try {
			new Notice(forceUpdate ? 'Force re-syncing Google Calendar…' : 'Syncing Google Calendar…');

			const now = new Date();
			const timeMin = new Date(now);
			timeMin.setDate(now.getDate() - settings.syncDaysBack);
			timeMin.setHours(0, 0, 0, 0);
			const timeMax = new Date(now);
			timeMax.setDate(now.getDate() + settings.syncDaysForward);
			timeMax.setHours(23, 59, 59, 999);

			// Rebuild the event-id → file path index
			await this.noteManager.buildIndex();

			// Fetch the names of all enabled calendars
			const allCalendars = await this.api.fetcher.listCalendars();
			const calendarMap = new Map(allCalendars.map(c => [c.id, c.name]));

			for (const calendarId of settings.enabledCalendars) {
				const calendarName = calendarMap.get(calendarId) ?? calendarId;
				try {
					const calResult = await this.syncCalendar(calendarId, calendarName, timeMin, timeMax, forceUpdate);
					result.created += calResult.created;
					result.updated += calResult.updated;
					result.deleted += calResult.deleted;
					result.skipped += calResult.skipped;
					result.errors.push(...calResult.errors);
				} catch (err: any) {
					const msg = `Calendar "${calendarName}": ${err?.message ?? err}`;
					result.errors.push(msg);
					console.error(msg, err);
				}
			}

			settings.lastSyncTime = new Date().toISOString();
			await this.saveSettings();

			const summary = [
				`Sync complete:`,
				result.created > 0 ? `${result.created} created` : '',
				result.updated > 0 ? `${result.updated} updated` : '',
				result.deleted > 0 ? `${result.deleted} deleted` : '',
				result.skipped > 0 ? `${result.skipped} skipped` : '',
			].filter(Boolean).join(' ');

			new Notice(summary || 'Sync complete: no changes.');

			if (result.errors.length > 0) {
				console.error('Sync errors:', result.errors);
				new Notice(`Sync finished with ${result.errors.length} error(s). Check the console for details.`);
			}
		} catch (err: any) {
			const msg = err?.message ?? String(err);
			result.errors.push(msg);
			new Notice(`Sync failed: ${msg}`);
			console.error('Sync failed:', err);
		} finally {
			this.isSyncing = false;
		}

		return result;
	}

	private async syncCalendar(
		calendarId: string,
		calendarName: string,
		timeMin: Date,
		timeMax: Date,
		forceUpdate = false
	): Promise<SyncResult> {
		const result: SyncResult = { created: 0, updated: 0, deleted: 0, skipped: 0, errors: [] };
		const settings = this.getSettings();
		const existingSyncToken = settings.syncTokens[calendarId];

		let fetchResult = await this.api.fetcher.fetchEventsForCalendar(
			calendarId, calendarName, timeMin, timeMax, existingSyncToken
		);

		// syncToken was stale (410 Gone) — persist the deletion immediately so a crash
		// during the retry doesn't leave a stale token in saved settings.
		if (fetchResult.resetToken) {
			delete settings.syncTokens[calendarId];
			await this.saveSettings();
			fetchResult = await this.api.fetcher.fetchEventsForCalendar(
				calendarId, calendarName, timeMin, timeMax
			);
		}

		for (const event of fetchResult.events) {
			try {
				if (event.status === 'cancelled') {
					await this.handleCancelledEvent(event, result);
				} else {
					const outcome = await this.upsertEventNote(event, forceUpdate);
					if (outcome === 'created') result.created++;
					else if (outcome === 'updated') result.updated++;
					else result.skipped++;
				}
			} catch (err: any) {
				result.errors.push(`Event "${event.title}": ${err?.message ?? err}`);
			}
		}

		// Persist the new sync token so the next run is incremental
		if (fetchResult.nextSyncToken) {
			settings.syncTokens[calendarId] = fetchResult.nextSyncToken;
			await this.saveSettings();
		}

		return result;
	}

	private async upsertEventNote(event: CalendarEventNote, forceUpdate = false): Promise<'created' | 'updated' | 'skipped'> {
		const existingFile = this.noteManager.findNoteByEventId(event.eventId);

		if (!existingFile) {
			const body = await this.templateEngine.renderBody(event, this.getSettings().templatePath);
			await this.noteManager.createEventNote(event, body);
			this.onNoteUpserted?.(event.eventId, this.noteManager.buildSnapshot(event));
			return 'created';
		}

		// Check if the event has actually changed since the note was last written.
		// Skip this check on force re-sync so all notes are rewritten from Google.
		const cache = this.app.metadataCache.getFileCache(existingFile);
		const storedUpdated = cache?.frontmatter?.['cal-updated'] ?? cache?.frontmatter?.['gcal-updated'];
		const hasCalendarId = !!(cache?.frontmatter?.['cal-calendar-id'] ?? cache?.frontmatter?.['gcal-calendar-id']);
		if (!forceUpdate && storedUpdated && storedUpdated === event.updated && hasCalendarId) {
			// Even when skipped, ensure the snapshot is registered (covers first-run gap)
			this.onNoteUpserted?.(event.eventId, this.noteManager.buildSnapshot(event));
			// Still rename if the filename is stale (e.g. after title format change)
			await this.noteManager.renameIfNeeded(existingFile, event);
			return 'skipped';
		}

		await this.noteManager.updateEventNote(existingFile, event);
		this.onNoteUpserted?.(event.eventId, this.noteManager.buildSnapshot(event));
		return 'updated';
	}

	private async handleCancelledEvent(event: CalendarEventNote, result: SyncResult): Promise<void> {
		const file = this.noteManager.findNoteByEventId(event.eventId);
		if (!file) return;

		if (this.getSettings().deleteNotesForRemovedEvents) {
			await this.noteManager.deleteEventNote(file);
			result.deleted++;
		} else {
			await this.noteManager.markEventCancelled(file);
			result.updated++;
		}
	}

	startAutoSync(): void {
		this.stopAutoSync();
		const interval = this.getSettings().autoSyncInterval;
		if (interval <= 0) return;
		this.intervalHandle = window.setInterval(() => {
			this.runSync();
		}, interval * 60 * 1000);
	}

	stopAutoSync(): void {
		if (this.intervalHandle !== null) {
			window.clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
	}

	restartAutoSync(): void {
		this.stopAutoSync();
		this.startAutoSync();
	}
}
