import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { parse, stringify } from 'yaml';
import { CalendarEventNote, FrontmatterSnapshot, GoogleCalendarSyncSettings } from './types';

// Frontmatter keys that are "owned" by the sync engine.  During a G→O update
// these are overwritten with Google's values; all other keys the user may have
// added (tags, links, custom fields) are preserved.
//
// All sync-managed keys use the "gcal-" prefix so they are visually distinct
// from user-defined properties.
//
// TODO (future): expose a toggle in settings to let users opt-out of the prefix
// and use flat names instead, with a list of the affected properties shown in the
// settings panel so they know exactly what will change.
const SYNC_OWNED_KEYS = new Set([
	'cal-type', 'cal-calendar', 'cal-calendar-id', 'cal-event-id',
	'title', 'date', 'startTime', 'endTime', 'endDate',
	'allDay', 'cal-location', 'cal-description',
	'cal-attendees', 'cal-organizer', 'cal-status',
	'cal-video-link', 'cal-event-link',
	'cal-is-recurring', 'cal-recurrence-master-id',
	'cal-timezone', 'cal-created', 'cal-updated',
]);

export class NoteManager {
	// In-memory index: eventId -> vault path
	private eventIndex = new Map<string, string>();

	// Counter to prevent echo-loop in two-way sync: >0 during vault writes
	private writeDepth = 0;

	get isWriting(): boolean {
		return this.writeDepth > 0;
	}

	beginWrite(): void { this.writeDepth++; }
	endWrite(): void { this.writeDepth--; }

	constructor(private app: App, private settings: GoogleCalendarSyncSettings) {}

	async buildIndex(): Promise<void> {
		this.eventIndex.clear();
		const folder = this.app.vault.getAbstractFileByPath(
			normalizePath(this.settings.syncFolder)
		);
		if (!folder || !(folder instanceof TFolder)) return;

		for (const file of this.getAllMarkdownFiles(folder)) {
			const cache = this.app.metadataCache.getFileCache(file);
			// Fall back to legacy "event-id" so existing notes are found during migration
			const eventId = cache?.frontmatter?.['cal-event-id'] ?? cache?.frontmatter?.['gcal-event-id'];
			if (eventId && typeof eventId === 'string' && eventId.trim()) {
				this.eventIndex.set(eventId, file.path);
			}
		}
	}

	private getAllMarkdownFiles(folder: TFolder): TFile[] {
		const files: TFile[] = [];
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') {
				files.push(child);
			} else if (child instanceof TFolder) {
				files.push(...this.getAllMarkdownFiles(child));
			}
		}
		return files;
	}

	findNoteByEventId(eventId: string): TFile | null {
		const path = this.eventIndex.get(eventId);
		if (!path) return null;
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	getNotePathForEvent(event: CalendarEventNote): string {
		const format = this.settings.noteTitleFormat || '{title} {date}';
		const baseName = this.sanitizeFilename(
			format
				.replace(/\{title\}/g, event.title)
				.replace(/\{date\}/g, event.date)
		);
		const calendarFolder = this.sanitizeFilename(event.calendarName);
		const baseFolder = normalizePath(`${this.settings.syncFolder}/${calendarFolder}`);
		const basePath = normalizePath(`${baseFolder}/${baseName}.md`);

		// Check for filename collision with a different event
		const existing = this.app.vault.getAbstractFileByPath(basePath);
		if (existing instanceof TFile) {
			const cache = this.app.metadataCache.getFileCache(existing);
			// Fall back to legacy "event-id" for collision detection during migration
		const existingId = cache?.frontmatter?.['cal-event-id'] ?? cache?.frontmatter?.['gcal-event-id'];
			if (existingId && existingId !== event.eventId) {
				const suffix = event.eventId.slice(-6);
				return normalizePath(`${baseFolder}/${baseName}_${suffix}.md`);
			}
		}

		return basePath;
	}

	async ensureFolderExists(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		const segments = normalized.split('/');
		let current = '';
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch {
					// Folder may have been created concurrently; ignore
				}
			}
		}
	}

	// Parse per-calendar custom properties from the multiline settings textarea.
	// Each non-empty line must be "key = value"; lines without "=" are ignored.
	// Values are stored as plain strings; yaml.stringify handles quoting as needed.
	private parseCustomProperties(raw: string): Record<string, string> {
		const result: Record<string, string> = {};
		for (const line of raw.split('\n')) {
			const eqIdx = line.indexOf('=');
			if (eqIdx < 0) continue;
			const key = line.slice(0, eqIdx).trim();
			const value = line.slice(eqIdx + 1).trim();
			if (key) result[key] = value;
		}
		return result;
	}

	// Convert a 24hr "HH:MM" string to the user's preferred time format.
	// Input is always 24hr from calendarFetcher; output depends on settings.timeFormat.
	private formatTime(time24: string | null): string | null {
		if (!time24) return null;
		if (this.settings.timeFormat === '24h') return time24;
		const [hStr, mStr] = time24.split(':');
		const h = parseInt(hStr, 10);
		const period = h >= 12 ? 'PM' : 'AM';
		const h12 = h % 12 || 12;
		return `${h12}:${mStr} ${period}`;
	}

	buildFrontmatter(event: CalendarEventNote): Record<string, unknown> {
		const custom = this.parseCustomProperties(
			this.settings.calendarCustomProperties?.[event.calendarId] ?? ''
		);
		return {
			// Custom properties first; standard fields below always take precedence
			...custom,
			'cal-type': 'calendar-event',
			'cal-calendar': event.calendarName,
			'cal-calendar-id': event.calendarId,
			'cal-event-id': event.eventId,
			'title': event.title,
			'date': event.date,
			'startTime': this.formatTime(event.startTime),
			'endTime': this.formatTime(event.endTime),
			'endDate': event.endDate ?? null,
			'cal-location': event.location || null,
			'cal-description': event.description || null,
			'cal-attendees': event.attendees.length > 0 ? event.attendees : null,
			'cal-organizer': event.organizer || null,
			'cal-status': event.status,
			'cal-video-link': event.videoLink || null,
			'cal-event-link': event.eventLink
				? event.eventLink + (this.settings.googleUserEmail
					? `&authuser=${encodeURIComponent(this.settings.googleUserEmail)}`
					: '')
				: null,
			'cal-is-recurring': event.isRecurring,
			'cal-recurrence-master-id': event.recurrenceMasterId ?? null,
			'cal-timezone': event.timezone,
			'cal-created': event.created,
			'cal-updated': event.updated,
		};
	}

	buildSnapshot(event: CalendarEventNote): FrontmatterSnapshot {
		return {
			title: event.title,
			date: event.date,
			startTime: event.startTime,
			endTime: event.endTime,
			allDay: event.allDay,
			endDate: event.endDate ?? null,
			location: event.location,
			description: event.description,
			updated: event.updated,
		};
	}

	async createEventNote(event: CalendarEventNote, body: string): Promise<TFile> {
		const path = this.getNotePathForEvent(event);
		const folderPath = path.substring(0, path.lastIndexOf('/'));
		await this.ensureFolderExists(folderPath);

		const content = this.buildNoteContent(this.buildFrontmatter(event), body);

		this.writeDepth++;
		try {
			const file = await this.app.vault.create(path, content);
			this.eventIndex.set(event.eventId, file.path);
			return file;
		} finally {
			this.writeDepth--;
		}
	}

	async updateEventNote(file: TFile, event: CalendarEventNote): Promise<TFile> {
		const currentContent = await this.app.vault.read(file);
		const body = this.extractBody(currentContent);
		const existingFm = this.parseFrontmatter(currentContent);

		// Merge: start with existing (preserves user-added keys), then overwrite sync-owned keys
		const googleFm = this.buildFrontmatter(event);
		const merged: Record<string, unknown> = { ...existingFm };
		for (const key of SYNC_OWNED_KEYS) {
			if (key in googleFm) {
				merged[key] = googleFm[key];
			}
		}
		// Also include any custom properties from buildFrontmatter (calendar-specific)
		for (const key of Object.keys(googleFm)) {
			if (SYNC_OWNED_KEYS.has(key) || !(key in merged)) {
				merged[key] = googleFm[key];
			}
		}

		const content = this.buildNoteContent(merged, body);

		this.writeDepth++;
		try {
			await this.app.vault.modify(file, content);
			this.eventIndex.set(event.eventId, file.path);
		} finally {
			this.writeDepth--;
		}

		// Rename the file if the desired path has changed (e.g. event was rescheduled
		// or retitled).  fileManager.renameFile() triggers Obsidian's built-in link
		// updater so any [[wiki links]] to this note are rewritten automatically.
		const desiredPath = this.getNotePathForEvent(event);
		if (desiredPath !== file.path) {
			const desiredFolder = desiredPath.substring(0, desiredPath.lastIndexOf('/'));
			await this.ensureFolderExists(desiredFolder);
			this.writeDepth++;
			try {
				await this.app.fileManager.renameFile(file, desiredPath);
				this.eventIndex.set(event.eventId, desiredPath);
			} finally {
				this.writeDepth--;
			}
			const renamed = this.app.vault.getAbstractFileByPath(desiredPath);
			return renamed instanceof TFile ? renamed : file;
		}

		return file;
	}

	async markEventCancelled(file: TFile): Promise<void> {
		this.writeDepth++;
		try {
			await this.app.vault.process(file, (currentContent) => {
				const body = this.extractBody(currentContent);
				const fm = this.parseFrontmatter(currentContent);
				fm['cal-status'] = 'cancelled';
				return this.buildNoteContent(fm, body);
			});
		} finally {
			this.writeDepth--;
		}
	}

	async deleteEventNote(file: TFile): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		const eventId = cache?.frontmatter?.['cal-event-id'];
		if (eventId) this.eventIndex.delete(eventId);
		await this.app.fileManager.trashFile(file);
	}

	// Write the Google-assigned event-id back to a user-created note
	async writeEventId(file: TFile, eventId: string, createdTimestamp: string, updatedTimestamp: string): Promise<void> {
		this.writeDepth++;
		try {
			await this.app.vault.process(file, (currentContent) => {
				const body = this.extractBody(currentContent);
				const fm = this.parseFrontmatter(currentContent);
				fm['cal-type'] = 'calendar-event';
				fm['cal-event-id'] = eventId;
				fm['cal-created'] = createdTimestamp;
				fm['cal-updated'] = updatedTimestamp;
				return this.buildNoteContent(fm, body);
			});
			this.eventIndex.set(eventId, file.path);
		} finally {
			this.writeDepth--;
		}
	}

	// Remove a file from the index (called when a note is deleted externally)
	removeFromIndex(eventId: string): void {
		this.eventIndex.delete(eventId);
	}

	// Update the index when a file is renamed/moved
	updateIndexPath(oldPath: string, newPath: string): void {
		for (const [eventId, path] of this.eventIndex.entries()) {
			if (path === oldPath) {
				this.eventIndex.set(eventId, newPath);
				return;
			}
		}
	}

	buildNoteContent(frontmatter: Record<string, unknown>, body: string): string {
		const yamlStr = stringify(frontmatter, { lineWidth: 0 });
		// Quote time values (HH:MM) so Obsidian's YAML 1.1 parser doesn't misread
		// them as sexagesimal integers (e.g. 10:00 → 600).
		const safeYaml = yamlStr.replace(/^(startTime|endTime): (\d{1,2}:\d{2})$/gm, "$1: '$2'");
		return `---\n${safeYaml}---\n${body}`;
	}

	// Extract everything after the closing frontmatter delimiter
	extractBody(content: string): string {
		const lines = content.split('\n');
		if (lines[0]?.trim() !== '---') return content;

		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				// Return everything after this line, stripping leading blank lines
				const rest = lines.slice(i + 1).join('\n');
				return rest.replace(/^\n+/, '');
			}
		}
		return content;
	}

	// Parse YAML frontmatter block into a plain object
	parseFrontmatter(content: string): Record<string, unknown> {
		const lines = content.split('\n');
		if (lines[0]?.trim() !== '---') return {};

		const yamlLines: string[] = [];
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				try {
					return (parse(yamlLines.join('\n')) as Record<string, unknown>) || {};
				} catch {
					return {};
				}
			}
			yamlLines.push(lines[i]);
		}
		return {};
	}

	sanitizeFilename(name: string): string {
		return name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
	}
}
