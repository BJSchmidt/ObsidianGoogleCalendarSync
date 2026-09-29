import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import { Credentials } from 'google-auth-library';
import { GoogleCalendarAPI, GoogleCalendarCredentials } from './googleCalendarAPI';
import { NoteManager } from './noteManager';
import { TemplateEngine } from './templateEngine';
import { SyncEngine } from './syncEngine';
import { TwoWaySyncHandler, fmAllDay } from './twoWaySync';
import { GoogleCalendarSyncSettingTab } from './settingsTab';
import { CalendarEventModal } from './createEventModal';
import {
	MonthCalendarView, WeekCalendarView,
	SevenDayCalendarView, FourteenDayCalendarView, TwoWeekCalendarView,
	getViewOptions, loadTuiCss, unloadTuiCss,
} from './basesCalendarView';
import { DEFAULT_SETTINGS, GoogleCalendarSyncSettings, NewEventFormData } from './types';
import {
	getDeviceId,
	getDeviceName,
	isSyncEnabledOnDevice,
	isSyncEnabledOnDeviceUnset,
	setSyncEnabledOnDevice,
	detectOtherActiveDevice,
	formatAge,
} from './deviceOwnership';

export default class GoogleCalendarSync extends Plugin {
	settings: GoogleCalendarSyncSettings;
	api: GoogleCalendarAPI;
	noteManager: NoteManager;
	private templateEngine: TemplateEngine;
	syncEngine: SyncEngine;
	private twoWaySync: TwoWaySyncHandler;

	async onload() {
		await this.loadSettings();

		// Device-sync migration. On a new install the per-device flag defaults
		// to OFF to avoid two machines silently racing. But for an existing
		// user upgrading the plugin, the first machine to load should stay
		// enabled — assume the authenticated machine has been the syncer
		// all along, OR take over if no other device has ever stamped its id.
		if (isSyncEnabledOnDeviceUnset()) {
			const hasAuth = !!this.settings.googleAccessToken;
			const noPriorOwner = !this.settings.lastSyncDeviceId;
			const weAreTheOwner = this.settings.lastSyncDeviceId === getDeviceId();
			if (hasAuth && (noPriorOwner || weAreTheOwner)) {
				setSyncEnabledOnDevice(true);
			} else {
				setSyncEnabledOnDevice(false);
			}
		}

		this.api = new GoogleCalendarAPI(
			this.buildCredentials(),
			this.onTokensUpdated.bind(this)
		);

		this.noteManager = new NoteManager(this.app, this.settings);
		this.templateEngine = new TemplateEngine(this.app);

		this.syncEngine = new SyncEngine(
			this.app,
			this.api,
			this.noteManager,
			this.templateEngine,
			() => this.settings,
			() => this.saveSettings()
		);

		this.twoWaySync = new TwoWaySyncHandler(
			this.app,
			this.api,
			this.noteManager,
			() => this.settings,
			() => this.syncEngine.syncing
		);

		// Keep the two-way sync snapshot cache up to date after every G→O upsert
		this.syncEngine.onNoteUpserted = (eventId, snapshot) => {
			this.twoWaySync.updateSnapshot(eventId, snapshot);
		};

		// Wait for the workspace to be ready, then for Obsidian Sync to settle, then
		// initialize snapshots and run the first G→O sync.  O→G watching (syncReady)
		// is intentionally blocked until after the first G→O sync so that stale notes
		// restored by Obsidian Sync cannot push months-old data to Google Calendar
		// before fresh notes have been written and snapshots updated.
		this.app.workspace.onLayoutReady(async () => {
			// Wait for Obsidian Sync to finish downloading cloud changes before we
			// read or write any notes.  No-op if Obsidian Sync is not enabled.
			await this.waitForObsidianSync();

			await this.provisionDefaultTemplate();

			// Ensure the event-id index is built (with duplicate detection) before
			// two-way sync initializes snapshots. buildIndex runs again inside
			// runSync, but doing it once now so the warning appears even when the
			// user has sync disabled on this device.
			await this.noteManager.buildIndex();
			this.warnAboutDuplicatesIfAny();
			this.warnAboutOtherDeviceIfAny();

			try {
				await this.twoWaySync.initialize();
			} catch (err) {
				console.error('GoogleCalendarSync: initialize failed:', err);
			}

			if (
				this.settings.googleAccessToken &&
				this.settings.enabledCalendars.length > 0 &&
				isSyncEnabledOnDevice()
			) {
				try {
					await this.syncEngine.runSync();
				} catch (err) {
					console.error('GoogleCalendarSync: startup sync failed:', err);
				}
			}

			// Unblock O→G watching now that snapshots reflect current Google state
			this.twoWaySync.setSyncReady(true);

			// Push any existing files in the sync folder that have a date but no event-id
			// (e.g. events created by Full Calendar before this plugin ran)
			try {
				await this.twoWaySync.scanForUnsyncedFiles();
			} catch (err) {
				console.error('GoogleCalendarSync: scanForUnsyncedFiles failed:', err);
			}
		});

		// Ribbon icon for manual sync
		this.addRibbonIcon('calendar-glyph', 'Sync Google Calendar', () => {
			this.syncEngine.runSync();
		});

		// Ribbon icon to open the calendar base file (opt-in in settings)
		if (this.settings.showCalendarRibbonButton) {
			this.addRibbonIcon('calendar', 'Open Calendar', () => {
				this.openCalendarBase();
			});
		}

		// Commands
		this.addCommand({
			id: 'sync-google-calendar',
			name: 'Sync Google Calendar',
			callback: () => this.syncEngine.runSync(),
		});

		this.addCommand({
			id: 'open-calendar-base',
			name: 'Open Calendar',
			callback: () => this.openCalendarBase(),
		});

		this.addCommand({
			id: 'new-calendar-event',
			name: 'New Calendar Event',
			callback: () => this.openCreateEventModal(),
		});

		this.addCommand({
			id: 'edit-calendar-event',
			name: 'Edit Calendar Event',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				const cache = this.app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (!fm?.['cal-event-id'] && !fm?.['calendar'] && !fm?.['cal-calendar']) return false;
				if (!checking) this.openEditEventModal(file);
				return true;
			},
		});

		this.addCommand({
			id: 'add-to-calendar',
			name: 'Add to Calendar',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) this.openAddToCalendarModal(file);
				return true;
			},
		});

		this.addCommand({
			id: 're-sync-google-calendar-force',
			name: 'Force re-sync Google Calendar (refresh all notes)',
			callback: () => this.syncEngine.runForceResync(),
		});

		this.addCommand({
			id: 're-sync-current-note',
			name: 'Re-sync current note from Google Calendar',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				const cache = this.app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (!fm?.['cal-event-id'] || !fm?.['cal-calendar-id']) return false;
				if (!checking) this.syncEngine.resyncSingleNote(file);
				return true;
			},
		});

		this.addCommand({
			id: 'push-current-note',
			name: 'Push current note to Google Calendar',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				const cache = this.app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (!fm?.['cal-event-id'] || !fm?.['cal-calendar-id']) return false;
				if (!checking) this.twoWaySync.forcePushNote(file);
				return true;
			},
		});

		this.addCommand({
			id: 'find-duplicate-event-notes',
			name: 'Find duplicate event notes',
			callback: () => this.reportDuplicateEventNotes(),
		});

		this.addCommand({
			id: 'clean-duplicate-event-notes',
			name: 'Clean duplicate event notes (trash extras, keep oldest)',
			callback: () => this.cleanDuplicateEventNotes(),
		});

		// Settings tab
		this.addSettingTab(new GoogleCalendarSyncSettingTab(this.app, this));

		// Bases calendar views — inject TUI Calendar CSS
		loadTuiCss();

		this.registerBasesView('cal-month', {
			name: 'Month Calendar',
			icon: 'calendar',
			factory: (controller, containerEl) => new MonthCalendarView(controller, containerEl),
			options: getViewOptions,
		});

		this.registerBasesView('cal-week', {
			name: 'Week Calendar',
			icon: 'calendar-range',
			factory: (controller, containerEl) => new WeekCalendarView(controller, containerEl),
			options: getViewOptions,
		});

		this.registerBasesView('cal-7day', {
			name: '7-Day Lookahead',
			icon: 'calendar-range',
			factory: (controller, containerEl) => new SevenDayCalendarView(controller, containerEl),
			options: getViewOptions,
		});

		this.registerBasesView('cal-14day', {
			name: '14-Day Lookahead',
			icon: 'calendar-range',
			factory: (controller, containerEl) => new FourteenDayCalendarView(controller, containerEl),
			options: getViewOptions,
		});

		this.registerBasesView('cal-2week', {
			name: '2-Week Calendar',
			icon: 'calendar-range',
			factory: (controller, containerEl) => new TwoWeekCalendarView(controller, containerEl),
			options: getViewOptions,
		});

		// Two-way sync: watch for file modifications
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.twoWaySync.handleFileModify(file);
				}
			})
		);

		// Two-way sync: watch for new file creation
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.twoWaySync.handleFileCreate(file);
				}
			})
		);

		// Two-way sync: push deletion to Google when a synced note is deleted.
		// We capture frontmatter from the metadata cache (still available briefly
		// after deletion) so we know which calendar/event to target.
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					const cache = this.app.metadataCache.getCache(file.path);
					const fm = cache?.frontmatter;
					if (fm && (fm['cal-type'] === 'calendar-event' || fm['cal-event-id'])) {
						this.twoWaySync.handleFileDelete(file, fm);
					}
				}
			})
		);

		// Keep event index in sync when files are renamed/moved, and follow a
		// filename change through to the note's title (and on to Google).
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.noteManager.updateIndexPath(oldPath, file.path);
					this.twoWaySync.handleFileRename(file, oldPath);
				}
			})
		);

		// Auto-sync — only if the user has opted this device in
		if (this.settings.autoSyncInterval > 0 && isSyncEnabledOnDevice()) {
			this.syncEngine.startAutoSync();
		}
	}

	private warnAboutOtherDeviceIfAny(): void {
		const warning = detectOtherActiveDevice(
			this.settings.lastSyncDeviceId,
			this.settings.lastSyncDeviceName,
			this.settings.lastSyncAt,
		);
		if (!warning) return;

		const thisDevice = getDeviceName();
		const thisEnabled = isSyncEnabledOnDevice();
		const age = formatAge(warning.ageMs);

		if (thisEnabled) {
			// Both devices have sync on — loud warning, high risk of duplicates.
			const msg = `Google Calendar Sync: "${warning.deviceName}" also synced this vault ${age}. Two devices syncing simultaneously can create duplicate notes and overwrite each other. Disable sync on one device in Settings → Google Calendar Sync.`;
			new Notice(msg, 15000);
			console.warn(`[google-calendar-sync] ${msg} (this device: ${thisDevice}, other device: ${warning.deviceId})`);
		} else {
			// Only the other device is syncing — informational log, no modal.
			console.log(`[google-calendar-sync] sync is owned by "${warning.deviceName}" (last synced ${age}). This device ("${thisDevice}") is a read-only viewer.`);
		}
	}

	private warnAboutDuplicatesIfAny(): void {
		const dupes = this.noteManager.getDuplicateEventNotes();
		if (dupes.length === 0) return;
		const example = dupes[0];
		new Notice(
			`Google Calendar Sync: found ${dupes.length} event(s) with duplicate notes (e.g. ${example.paths.length} copies of ${example.eventId.slice(-8)}). Run the "Find duplicate event notes" command to review.`,
			12000,
		);
	}

	private reportDuplicateEventNotes(): void {
		const dupes = this.noteManager.getDuplicateEventNotes();
		if (dupes.length === 0) {
			new Notice('No duplicate event notes found.');
			return;
		}
		console.group(`[google-calendar-sync] ${dupes.length} duplicate event-id(s):`);
		for (const { eventId, paths } of dupes) {
			console.log(`${eventId}`);
			for (let i = 0; i < paths.length; i++) {
				console.log(`  ${i === 0 ? 'KEEP' : 'EXTRA'}: ${paths[i]}`);
			}
		}
		console.groupEnd();
		new Notice(
			`Found ${dupes.length} event(s) with duplicate notes. See console (Ctrl/Cmd+Shift+I) for the list. Run "Clean duplicate event notes" to trash the extras.`,
			10000,
		);
	}

	private async cleanDuplicateEventNotes(): Promise<void> {
		await this.noteManager.buildIndex();
		const dupes = this.noteManager.getDuplicateEventNotes();
		if (dupes.length === 0) {
			new Notice('No duplicate event notes found.');
			return;
		}
		let trashed = 0;
		let failed = 0;
		for (const { paths } of dupes) {
			// paths[0] is the oldest — the "winner". Trash the rest.
			for (const extra of paths.slice(1)) {
				const file = this.app.vault.getAbstractFileByPath(extra);
				if (!(file instanceof TFile)) continue;
				try {
					await this.app.fileManager.trashFile(file);
					console.log(`[google-calendar-sync] trashed duplicate: ${extra}`);
					trashed++;
				} catch (err) {
					console.error(`[google-calendar-sync] failed to trash ${extra}:`, err);
					failed++;
				}
			}
		}
		// Rebuild so the in-memory index matches the new vault state
		await this.noteManager.buildIndex();
		new Notice(
			`Cleaned ${trashed} duplicate note(s)${failed ? `, ${failed} failed (check console)` : ''}. Kept the oldest note for each event.`,
			8000,
		);
	}

	onunload() {
		this.syncEngine?.stopAutoSync();
		this.twoWaySync?.destroy();
		this.api?.cleanup();
		unloadTuiCss();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async handleGoogleAuth() {
		if (!this.settings.googleClientId || !this.settings.googleClientSecret) {
			new Notice('Please enter your Google client ID and secret first.');
			return;
		}

		// Rebuild the API with the latest credentials before starting OAuth
		this.api = new GoogleCalendarAPI(
			this.buildCredentials(),
			this.onTokensUpdated.bind(this)
		);

		try {
			const tokens = await this.api.startOAuthFlow();
			if (tokens.access_token) {
				this.settings.googleAccessToken = tokens.access_token;
				this.settings.googleRefreshToken = tokens.refresh_token || '';
				// Clear stale sync tokens since we have fresh credentials
				this.settings.syncTokens = {};
				await this.saveSettings();

				// Re-initialize with new tokens
				this.api = new GoogleCalendarAPI(
					this.buildCredentials(),
					this.onTokensUpdated.bind(this)
				);
				this.rebuildServices();

				new Notice('Google Calendar authorized successfully!');
			}
		} catch (error) {
			console.error('Error during OAuth flow:', error);
			new Notice('Authorization failed. Check the console for details.');
		}
	}

	private async openCalendarBase(): Promise<void> {
		const path = this.settings.calendarBasePath;
		if (!path) {
			new Notice('Set a Calendar base path in plugin settings.');
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`Calendar base not found: ${path}`);
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
	}

	private openCreateEventModal(): void {
		const settings = this.settings;

		let calendars = (settings.cachedCalendars || [])
			.filter(c => settings.enabledCalendars.includes(c.id));

		if (calendars.length === 0) {
			calendars = [{
				id: settings.defaultCalendarId || 'primary',
				name: 'Primary',
				color: '#4285F4',
				isPrimary: true,
				accessRole: 'owner',
			}];
		}

		new CalendarEventModal(
			this.app,
			calendars,
			settings.defaultCalendarId,
			(formData) => this.createNewEventNote(formData)
		).open();
	}

	private async openEditEventModal(file: TFile): Promise<void> {
		const settings = this.settings;
		const content = await this.app.vault.read(file);
		const fm = this.noteManager.parseFrontmatter(content);

		if (!fm['cal-event-id'] && !fm['calendar'] && !fm['cal-calendar']) {
			new Notice('This note is not a calendar event.');
			return;
		}

		let calendars = (settings.cachedCalendars || [])
			.filter(c => settings.enabledCalendars.includes(c.id));

		if (calendars.length === 0) {
			calendars = [{
				id: settings.defaultCalendarId || 'primary',
				name: 'Primary',
				color: '#4285F4',
				isPrimary: true,
				accessRole: 'owner',
			}];
		}

		// Build initial form data from existing frontmatter
		const initialData: NewEventFormData = {
			title: String(fm['title'] ?? ''),
			date: String(fm['date'] ?? ''),
			startTime: String(fm['startTime'] ?? ''),
			endTime: String(fm['endTime'] ?? ''),
			endDate: String(fm['endDate'] ?? ''),
			allDay: fmAllDay(fm),
			calendarId: String(fm['cal-calendar-id'] ?? settings.defaultCalendarId ?? 'primary'),
			calendarName: String(fm['calendar'] ?? fm['cal-calendar'] ?? 'Primary'),
			location: String(fm['cal-location'] ?? ''),
			description: String(fm['cal-description'] ?? ''),
			tags: Array.isArray(fm['tags']) ? fm['tags'].map(String) : [],
			people: Array.isArray(fm['people']) ? fm['people'].map(String) : [],
		};

		new CalendarEventModal(
			this.app,
			calendars,
			settings.defaultCalendarId,
			(formData) => this.updateEventFromModal(file, formData),
			initialData,
			String(fm['cal-event-link'] ?? ''),
			file,
		).open();
	}

	async updateEventFromModal(file: TFile, formData: NewEventFormData): Promise<void> {
		const content = await this.app.vault.read(file);
		const existingFm = this.noteManager.parseFrontmatter(content);
		const body = this.noteManager.extractBody(content);

		// Merge: preserve all existing keys, overwrite editable fields
		const merged: Record<string, unknown> = {
			...existingFm,
			'title': formData.title,
			'date': formData.date,
			'startTime': formData.allDay ? null : (formData.startTime || null),
			'endTime': formData.allDay ? null : (formData.endTime || null),
			'endDate': formData.allDay ? null : (formData.endDate || null),
			'allDay': formData.allDay,
			'calendar': formData.calendarName,
			'cal-calendar-id': formData.calendarId,
			'cal-location': formData.location || null,
			'cal-description': formData.description || null,
			'tags': formData.tags.length > 0 ? formData.tags : null,
			'people': formData.people.length > 0 ? formData.people : null,
		};
		// Migrate legacy cal-calendar → calendar
		delete merged['cal-calendar'];

		const newContent = this.noteManager.buildNoteContent(merged, body);

		try {
			await this.app.vault.modify(file, newContent);
			new Notice('Event updated.');
		} catch (err) {
			console.error('Error updating event note:', err);
			new Notice('Failed to update event note.');
		}
	}

	private async openAddToCalendarModal(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const fm = this.noteManager.parseFrontmatter(content);

		// Case 1: already a synced event → edit it
		if (fm['cal-event-id']) {
			this.openEditEventModal(file);
			return;
		}

		// Case 2: has calendar + date but no event-id → two-way sync will pick it up
		if ((fm['calendar'] || fm['cal-calendar']) && fm['date']) {
			new Notice('This note will be added to Google Calendar on the next sync.');
			return;
		}

		// Case 3: open modal to write calendar properties onto this note
		const settings = this.settings;
		let calendars = (settings.cachedCalendars || [])
			.filter(c => settings.enabledCalendars.includes(c.id));
		if (calendars.length === 0) {
			calendars = [{
				id: settings.defaultCalendarId || 'primary',
				name: 'Primary',
				color: '#4285F4',
				isPrimary: true,
				accessRole: 'owner',
			}];
		}

		const initialData: NewEventFormData = {
			title: String(fm['title'] ?? file.basename),
			date: String(fm['date'] ?? new Date().toISOString().slice(0, 10)),
			startTime: '',
			endTime: '',
			endDate: '',
			allDay: false,
			calendarId: settings.defaultCalendarId || 'primary',
			calendarName: calendars[0]?.name ?? 'Primary',
			location: '',
			description: '',
			tags: Array.isArray(fm['tags']) ? fm['tags'].map(String) : [],
			people: Array.isArray(fm['people']) ? fm['people'].map(String) : [],
		};

		new CalendarEventModal(
			this.app,
			calendars,
			settings.defaultCalendarId,
			(formData) => this.addNoteToCalendar(file, formData),
			initialData,
		).open();
	}

	private async addNoteToCalendar(file: TFile, formData: NewEventFormData): Promise<void> {
		const content = await this.app.vault.read(file);
		const existingFm = this.noteManager.parseFrontmatter(content);
		const body = this.noteManager.extractBody(content);

		// Merge calendar properties into existing frontmatter.
		// Don't set cal-event-id — two-way sync assigns it after the next save.
		const merged: Record<string, unknown> = {
			...existingFm,
			'cal-type': 'calendar-event',
			'calendar': formData.calendarName,
			'cal-calendar-id': formData.calendarId,
			'title': formData.title,
			'date': formData.date,
			'startTime': formData.allDay ? null : (formData.startTime || null),
			'endTime': formData.allDay ? null : (formData.endTime || null),
			'endDate': formData.allDay ? null : (formData.endDate || null),
			'allDay': formData.allDay,
			'cal-location': formData.location || null,
			'cal-description': formData.description || null,
			'cal-status': 'confirmed',
			'tags': formData.tags.length > 0 ? formData.tags : (existingFm['tags'] ?? null),
			'people': formData.people.length > 0 ? formData.people : (existingFm['people'] ?? null),
		};
		delete merged['cal-calendar'];

		const newContent = this.noteManager.buildNoteContent(merged, body);

		try {
			await this.app.vault.modify(file, newContent);
			new Notice('Note added to calendar — will sync to Google on next sync.');
		} catch (err) {
			console.error('Error adding note to calendar:', err);
			new Notice('Failed to update note.');
		}
	}

	async createNewEventNote(formData: NewEventFormData): Promise<void> {
		const settings = this.settings;
		const calendarFolder = this.noteManager.sanitizeFilename(formData.calendarName);
		const folderPath = normalizePath(`${settings.syncFolder}/${calendarFolder}`);
		await this.noteManager.ensureFolderExists(folderPath);

		// Build filename from title only; date appended on collision
		const baseName = this.noteManager.sanitizeFilename(formData.title);
		let filePath = normalizePath(`${folderPath}/${baseName}.md`);

		// Handle filename collision: append date, then timestamp
		if (this.app.vault.getAbstractFileByPath(filePath)) {
			const nameWithDate = this.noteManager.sanitizeFilename(`${formData.title} ${formData.date}`);
			filePath = normalizePath(`${folderPath}/${nameWithDate}.md`);
			if (this.app.vault.getAbstractFileByPath(filePath)) {
				const suffix = Date.now().toString(36);
				filePath = normalizePath(`${folderPath}/${nameWithDate}_${suffix}.md`);
			}
		}

		// Build frontmatter from form data
		const frontmatter: Record<string, unknown> = {
			'cal-type': 'calendar-event',
			'calendar': formData.calendarName,
			'cal-calendar-id': formData.calendarId,
			'cal-event-id': '',
			'title': formData.title,
			'date': formData.date,
			'startTime': formData.allDay ? null : (formData.startTime || null),
			'endTime': formData.allDay ? null : (formData.endTime || null),
			'endDate': formData.allDay ? null : (formData.endDate || null),
			'allDay': formData.allDay,
			'cal-location': formData.location || null,
			'cal-description': formData.description || null,
			'cal-attendees': null,
			'cal-organizer': null,
			'cal-status': 'confirmed',
			'cal-video-link': null,
			'tags': formData.tags.length > 0 ? formData.tags : null,
			'people': formData.people.length > 0 ? formData.people : null,
		};

		// Get the note body from template (strip template frontmatter, keep body only)
		const templateContent = await this.templateEngine.renderNewEventTemplate(
			settings.newEventTemplatePath
		);
		const body = this.noteManager.extractBody(templateContent);

		const content = this.noteManager.buildNoteContent(frontmatter, body);

		try {
			const file = await this.app.vault.create(filePath, content);
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
		} catch (err) {
			console.error('Error creating new event note:', err);
			new Notice('Failed to create new event note.');
		}
	}

	private buildCredentials(): GoogleCalendarCredentials {
		return {
			clientId: this.settings.googleClientId,
			clientSecret: this.settings.googleClientSecret,
			accessToken: this.settings.googleAccessToken,
			refreshToken: this.settings.googleRefreshToken,
		};
	}

	private async onTokensUpdated(tokens: Credentials): Promise<void> {
		if (tokens.access_token) {
			this.settings.googleAccessToken = tokens.access_token;
		}
		if (tokens.refresh_token) {
			this.settings.googleRefreshToken = tokens.refresh_token;
		}
		try {
			await this.saveSettings();
		} catch (err) {
			console.error('Failed to persist updated OAuth tokens:', err);
		}
	}

	private waitForObsidianSync(): Promise<void> {
		const sync = (this.app as any)?.internalPlugins?.plugins?.sync?.instance;
		if (!sync) return Promise.resolve();
		if (sync.syncStatus?.toLowerCase() === 'fully synced') return Promise.resolve();

		return new Promise<void>(resolve => {
			let done = false;
			const syncIntervalMs = (this.settings.autoSyncInterval ?? 15) * 60_000;

			// Notify after 2 minutes, then every sync interval thereafter
			const initialDelay = window.setTimeout(() => {
				new Notice('Google Calendar Sync is waiting for Obsidian Sync to finish…');
				const repeatInterval = window.setInterval(() => {
					if (done) { window.clearInterval(repeatInterval); return; }
					new Notice('Google Calendar Sync is still waiting for Obsidian Sync to finish…');
				}, syncIntervalMs);
			}, 2 * 60_000);

			sync.on('status-change', () => {
				if (sync.syncStatus?.toLowerCase() !== 'fully synced') return;
				if (done) return;
				done = true;
				window.clearTimeout(initialDelay);
				resolve();
			});
		});
	}

	private async provisionDefaultTemplate(): Promise<void> {
		if (this.settings.newEventTemplatePath) return;
		const templatePath = 'Resources/Templates/Calendar Event.md';
		const templateContent = [
			'---',
			'cal-type: calendar-event',
			'calendar: ',
			'title: ',
			'date: ',
			'startTime: ',
			'endTime: ',
			'allDay: false',
			'endDate: ',
			'cal-location: ',
			'cal-description: ',
			'cal-attendees:',
			'  - ',
			'cal-status: confirmed',
			'---',
			'',
			'# ',
			'',
		].join('\n');

		const existing = this.app.vault.getAbstractFileByPath(templatePath);
		if (!existing) {
			try {
				await this.app.vault.adapter.mkdir('Resources/Templates');
			} catch { /* folder already exists */ }
			try {
				await this.app.vault.create(templatePath, templateContent);
			} catch {
				return; // vault may not allow creation here; user can set path manually
			}
		}
		this.settings.newEventTemplatePath = templatePath;
		await this.saveSettings();
	}

	private rebuildServices(): void {
		this.noteManager = new NoteManager(this.app, this.settings);
		this.syncEngine = new SyncEngine(
			this.app,
			this.api,
			this.noteManager,
			this.templateEngine,
			() => this.settings,
			() => this.saveSettings()
		);
		this.twoWaySync = new TwoWaySyncHandler(
			this.app,
			this.api,
			this.noteManager,
			() => this.settings,
			() => this.syncEngine.syncing
		);
		this.syncEngine.onNoteUpserted = (eventId, snapshot) => {
			this.twoWaySync.updateSnapshot(eventId, snapshot);
		};
		if (this.settings.autoSyncInterval > 0) {
			this.syncEngine.startAutoSync();
		}
	}
}
