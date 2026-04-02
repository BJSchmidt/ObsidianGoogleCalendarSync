import { Notice, Plugin, TFile, normalizePath } from 'obsidian';
import { Credentials } from 'google-auth-library';
import { GoogleCalendarAPI, GoogleCalendarCredentials } from './googleCalendarAPI';
import { NoteManager } from './noteManager';
import { TemplateEngine } from './templateEngine';
import { SyncEngine } from './syncEngine';
import { TwoWaySyncHandler } from './twoWaySync';
import { GoogleCalendarSyncSettingTab } from './settingsTab';
import { CalendarEventModal } from './createEventModal';
import {
	MonthCalendarView, WeekCalendarView,
	SevenDayCalendarView, FourteenDayCalendarView, TwoWeekCalendarView,
	getViewOptions, loadTuiCss, unloadTuiCss,
} from './basesCalendarView';
import { DEFAULT_SETTINGS, GoogleCalendarSyncSettings, NewEventFormData } from './types';

export default class GoogleCalendarSync extends Plugin {
	settings: GoogleCalendarSyncSettings;
	api: GoogleCalendarAPI;
	noteManager: NoteManager;
	private templateEngine: TemplateEngine;
	syncEngine: SyncEngine;
	private twoWaySync: TwoWaySyncHandler;

	async onload() {
		await this.loadSettings();

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

			try {
				await this.twoWaySync.initialize();
			} catch (err) {
				console.error('GoogleCalendarSync: initialize failed:', err);
			}

			if (this.settings.googleAccessToken && this.settings.enabledCalendars.length > 0) {
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

		// Commands
		this.addCommand({
			id: 'sync-google-calendar',
			name: 'Sync Google Calendar',
			callback: () => this.syncEngine.runSync(),
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
				if (cache?.frontmatter?.['cal-type'] !== 'calendar-event') return false;
				if (!checking) this.openEditEventModal(file);
				return true;
			},
		});

		this.addCommand({
			id: 're-sync-google-calendar-force',
			name: 'Force re-sync Google Calendar (refresh all notes)',
			callback: () => this.syncEngine.runForceResync(),
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
					if (fm && fm['cal-type'] === 'calendar-event') {
						this.twoWaySync.handleFileDelete(file, fm);
					}
				}
			})
		);

		// Keep event index in sync when files are renamed/moved
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.noteManager.updateIndexPath(oldPath, file.path);
				}
			})
		);

		// Auto-sync
		if (this.settings.autoSyncInterval > 0) {
			this.syncEngine.startAutoSync();
		}
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

		if (fm['cal-type'] !== 'calendar-event') {
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
			allDay: Boolean(fm['allDay'] ?? false),
			calendarId: String(fm['cal-calendar-id'] ?? settings.defaultCalendarId ?? 'primary'),
			calendarName: String(fm['cal-calendar'] ?? 'Primary'),
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
			'cal-calendar': formData.calendarName,
			'cal-calendar-id': formData.calendarId,
			'cal-location': formData.location || null,
			'cal-description': formData.description || null,
			'tags': formData.tags.length > 0 ? formData.tags : null,
			'people': formData.people.length > 0 ? formData.people : null,
		};

		const newContent = this.noteManager.buildNoteContent(merged, body);

		try {
			await this.app.vault.modify(file, newContent);
			new Notice('Event updated.');
		} catch (err) {
			console.error('Error updating event note:', err);
			new Notice('Failed to update event note.');
		}
	}

	async createNewEventNote(formData: NewEventFormData): Promise<void> {
		const settings = this.settings;
		const calendarFolder = this.noteManager.sanitizeFilename(formData.calendarName);
		const folderPath = normalizePath(`${settings.syncFolder}/${calendarFolder}`);
		await this.noteManager.ensureFolderExists(folderPath);

		// Build filename from the title format setting
		const format = settings.noteTitleFormat || '{title} {date}';
		const baseName = this.noteManager.sanitizeFilename(
			format
				.replace(/\{title\}/g, formData.title)
				.replace(/\{date\}/g, formData.date)
		);
		let filePath = normalizePath(`${folderPath}/${baseName}.md`);

		// Handle filename collision
		if (this.app.vault.getAbstractFileByPath(filePath)) {
			const suffix = Date.now().toString(36);
			filePath = normalizePath(`${folderPath}/${baseName}_${suffix}.md`);
		}

		// Build frontmatter from form data
		const frontmatter: Record<string, unknown> = {
			'cal-type': 'calendar-event',
			'cal-calendar': formData.calendarName,
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
