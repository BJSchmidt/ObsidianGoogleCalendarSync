import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { GoogleCalendarListEntry } from './types';
import type GoogleCalendarSync from './main';

export class GoogleCalendarSyncSettingTab extends PluginSettingTab {
	plugin: GoogleCalendarSync;
	private availableCalendars: GoogleCalendarListEntry[] = [];
	private calendarListContainer: HTMLElement | null = null;
	private defaultCalendarContainer: HTMLElement | null = null;
	private isLoadingCalendars = false;
	private saveTimer: number | null = null;

	/** Debounced save — batches rapid changes (e.g. keystrokes) into a single disk write */
	private debouncedSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			this.plugin.saveSettings();
		}, 500);
	}

	constructor(app: App, plugin: GoogleCalendarSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Seed from persisted cache so calendars show immediately without a manual refresh
		if (this.availableCalendars.length === 0 && this.plugin.settings.cachedCalendars.length > 0) {
			this.availableCalendars = [...this.plugin.settings.cachedCalendars];
		}

		// ── Link-update warning (very top, shown only when needed) ───────────
		// Value is true = Always, false = Never, undefined = Ask (default).
		// "Ask" is risky because one missed click leaves broken links after a rename.
		const autoUpdateLinks = (this.app.vault as any).getConfig?.('alwaysUpdateLinks');
		if (autoUpdateLinks !== true) {
			const isNever = autoUpdateLinks === false;
			const warning = containerEl.createDiv({ cls: 'setting-item' });
			warning.style.borderLeft = `3px solid ${isNever ? 'var(--color-red)' : 'var(--color-yellow)'}`;
			warning.style.paddingLeft = '12px';
			warning.style.color = isNever ? 'var(--text-error)' : 'var(--text-warning)';
			warning.createEl('strong', {
				text: isNever
					? 'Action required: Automatic link updates are disabled.'
					: 'Recommendation: Set automatic link updates to Always.',
			});
			warning.createEl('p', {
				text: isNever
					? 'This plugin renames notes when events are rescheduled or retitled. ' +
					  'With "Automatically update internal links" set to Never, [[wiki links]] ' +
					  'to renamed notes will silently break. ' +
					  'Go to Settings → Files & Links → "Automatically update internal links" ' +
					  'and set it to Always.'
					: 'This plugin renames notes when events are rescheduled or retitled. ' +
					  '"Automatically update internal links" is currently set to Ask, which ' +
					  'prompts you each time — one missed click leaves broken [[wiki links]]. ' +
					  'Go to Settings → Files & Links → "Automatically update internal links" ' +
					  'and set it to Always to keep links working automatically.',
				cls: 'setting-item-description',
			});
		}

		// ── Status (top, no heading per Obsidian guidelines) ─────────────────
		const lastSync = this.plugin.settings.lastSyncTime
			? new Date(this.plugin.settings.lastSyncTime).toLocaleString()
			: 'Never';

		new Setting(containerEl)
			.setName('Last sync')
			.setDesc(`Last successful sync: ${lastSync}`)
			.addButton(btn => btn
				.setButtonText('Sync now')
				.setCta()
				.onClick(async () => {
					await this.plugin.syncEngine.runSync();
					this.display();
				}))
			.addButton(btn => btn
				.setButtonText('Force re-sync')
				.onClick(async () => {
					await this.plugin.syncEngine.runForceResync();
					this.display();
				}));

		// ── Authentication ──────────────────────────────────────────────────
		new Setting(containerEl).setName('Authentication').setHeading();

		new Setting(containerEl)
			.setName('Google client ID')
			.setDesc('OAuth 2.0 client ID from Google Cloud Console')
			.addText(text => text
				.setPlaceholder('Enter your Google client ID')
				.setValue(this.plugin.settings.googleClientId)
				.onChange((value) => {
					this.plugin.settings.googleClientId = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName('Google client secret')
			.setDesc('OAuth 2.0 client secret from Google Cloud Console')
			.addText(text => text
				.setPlaceholder('Enter your Google client secret')
				.setValue(this.plugin.settings.googleClientSecret)
				.onChange((value) => {
					this.plugin.settings.googleClientSecret = value;
					this.debouncedSave();
				}));

		const authStatus = this.plugin.settings.googleAccessToken
			? '✓ Authorized'
			: 'Not authorized';

		new Setting(containerEl)
			.setName('Authorization')
			.setDesc(`Status: ${authStatus}`)
			.addButton(btn => btn
				.setButtonText(this.plugin.settings.googleAccessToken ? 'Re-authorize' : 'Authorize')
				.setCta()
				.onClick(async () => {
					await this.plugin.handleGoogleAuth();
					this.display();
				}));

		if (this.plugin.settings.googleAccessToken) {
			new Setting(containerEl)
				.setName('Revoke authorization')
				.setDesc('Clear stored tokens and disconnect from Google Calendar')
				.addButton(btn => btn
					.setButtonText('Revoke')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.googleAccessToken = '';
						this.plugin.settings.googleRefreshToken = '';
						this.plugin.settings.syncTokens = {};
						await this.plugin.saveSettings();
						this.display();
					}));
		}

		// ── Sync Configuration ───────────────────────────────────────────────
		new Setting(containerEl).setName('Sync Configuration').setHeading();

		new Setting(containerEl)
			.setName('Sync folder')
			.setDesc('Root folder in your vault where event notes will be created. Calendar subfolders are created automatically.')
			.addText(text => text
				.setPlaceholder('Calendar')
				.setValue(this.plugin.settings.syncFolder)
				.onChange((value) => {
					this.plugin.settings.syncFolder = value || 'Calendar';
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName('Sync window: days back')
			.setDesc('How many days into the past to sync events (default: 30)')
			.addSlider(slider => slider
				.setLimits(0, 365, 1)
				.setValue(this.plugin.settings.syncDaysBack)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.syncDaysBack = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync window: days forward')
			.setDesc('How many days into the future to sync events (default: 30)')
			.addSlider(slider => slider
				.setLimits(0, 365, 1)
				.setValue(this.plugin.settings.syncDaysForward)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.plugin.settings.syncDaysForward = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-sync interval')
			.setDesc('How often to automatically sync in the background. Set to "Off" to disable auto-sync.')
			.addDropdown(drop => drop
				.addOption('0', 'Off')
				.addOption('5', '5 minutes')
				.addOption('10', '10 minutes')
				.addOption('15', '15 minutes')
				.addOption('30', '30 minutes')
				.addOption('60', '60 minutes')
				.setValue(String(this.plugin.settings.autoSyncInterval ?? 15))
				.onChange(async (value) => {
					this.plugin.settings.autoSyncInterval = parseInt(value, 10);
					await this.plugin.saveSettings();
					this.plugin.syncEngine.restartAutoSync();
				}));

		// ── Calendar Selection ───────────────────────────────────────────────
		new Setting(containerEl).setName('Calendars to Sync').setHeading();

		if (!this.plugin.settings.googleAccessToken) {
			containerEl.createEl('p', {
				text: 'Authorize Google Calendar above to load your calendars.',
				cls: 'setting-item-description',
			});
		} else {
			new Setting(containerEl)
				.setName('Load calendars')
				.setDesc('Fetch your Google Calendar list to select which to sync')
				.addButton(btn => btn
					.setButtonText(this.isLoadingCalendars ? 'Loading…' : 'Refresh calendar list')
					.onClick(async () => {
						await this.loadCalendars();
					}));

			this.calendarListContainer = containerEl.createDiv();
			this.defaultCalendarContainer = containerEl.createDiv();
			if (this.availableCalendars.length > 0) {
				this.renderCalendarList();
			} else {
				this.calendarListContainer.createEl('p', {
					text: 'Click "Refresh calendar list" to load your calendars.',
					cls: 'setting-item-description',
				});
			}
		}

		// ── Note Settings ────────────────────────────────────────────────────
		new Setting(containerEl).setName('Note Settings').setHeading();

		new Setting(containerEl)
			.setName('Note title format')
			.setDesc('Format for event note filenames. Available tokens: {title}, {date}. When an event is rescheduled, the note is automatically renamed and internal links are updated.')
			.addText(text => text
				.setPlaceholder('{title} {date}')
				.setValue(this.plugin.settings.noteTitleFormat)
				.onChange((value) => {
					this.plugin.settings.noteTitleFormat = value || '{title} {date}';
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName('Note body template')
			.setDesc('Path to a vault note used as the body template for synced event notes. Leave empty to use the default (# {{title}}). Supports {{title}}, {{date}}, {{startTime}}, {{location}}, etc.')
			.addText(text => text
				.setPlaceholder('Templates/Calendar Event.md')
				.setValue(this.plugin.settings.templatePath)
				.onChange((value) => {
					this.plugin.settings.templatePath = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName('New event template')
			.setDesc('Path to a vault note used as the template when creating new calendar events from Obsidian. Leave empty to use the built-in template.')
			.addText(text => text
				.setPlaceholder('Templates/New Calendar Event.md')
				.setValue(this.plugin.settings.newEventTemplatePath)
				.onChange((value) => {
					this.plugin.settings.newEventTemplatePath = value;
					this.debouncedSave();
				}));

		new Setting(containerEl)
			.setName('Time format')
			.setDesc('Display format for event start and end times in note frontmatter.')
			.addDropdown(drop => drop
				.addOption('12h', '12-hour (9:00 AM)')
				.addOption('24h', '24-hour (09:00)')
				.setValue(this.plugin.settings.timeFormat)
				.onChange(async (value: string) => {
					this.plugin.settings.timeFormat = value as '12h' | '24h';
					await this.plugin.saveSettings();
				}));

		// ── Event Handling ───────────────────────────────────────────────────
		new Setting(containerEl).setName('Event Handling').setHeading();

		new Setting(containerEl)
			.setName('Delete notes for removed events')
			.setDesc('When a Google Calendar event is deleted, delete its note. If disabled, the note is kept with status set to "cancelled".')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.deleteNotesForRemovedEvents)
				.onChange(async (value) => {
					this.plugin.settings.deleteNotesForRemovedEvents = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('When a synced note is deleted')
			.setDesc('What happens to the Google Calendar event when you delete its note in Obsidian.')
			.addDropdown(drop => drop
				.addOption('ignore', 'Do nothing')
				.addOption('cancel', 'Cancel the event')
				.addOption('delete', 'Delete the event')
				.setValue(this.plugin.settings.onNoteDeleteBehavior)
				.onChange(async (value: string) => {
					this.plugin.settings.onNoteDeleteBehavior = value as 'ignore' | 'cancel' | 'delete';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show push notifications')
			.setDesc('Show a notification when a local change is successfully pushed to Google Calendar, or when a push fails.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showPushNotifications)
				.onChange(async (value) => {
					this.plugin.settings.showPushNotifications = value;
					await this.plugin.saveSettings();
				}));

	}

	private async loadCalendars(): Promise<void> {
		if (this.isLoadingCalendars) return;
		this.isLoadingCalendars = true;
		try {
			this.availableCalendars = await this.plugin.api.fetcher.listCalendars();
			// The primary calendar's ID is the user's Gmail address — save it so we can
			// append ?authuser=EMAIL to event links, ensuring the correct account opens.
			const primaryCal = this.availableCalendars.find(c => c.isPrimary);
			if (primaryCal && primaryCal.id !== this.plugin.settings.googleUserEmail) {
				this.plugin.settings.googleUserEmail = primaryCal.id;
			}
			// Persist the list so it's available immediately on next plugin load
			this.plugin.settings.cachedCalendars = [...this.availableCalendars];
			await this.plugin.saveSettings();
			this.renderCalendarList();
		} catch (err) {
			new Notice('Failed to load calendars. Are you authorized?');
			console.error('Error loading calendars:', err);
		} finally {
			this.isLoadingCalendars = false;
		}
	}

	private renderCalendarList(): void {
		if (!this.calendarListContainer) return;
		this.calendarListContainer.empty();

		if (this.availableCalendars.length === 0) {
			this.calendarListContainer.createEl('p', {
				text: 'No calendars found.',
				cls: 'setting-item-description',
			});
			this.renderDefaultCalendarDropdown();
			return;
		}

		for (const cal of this.availableCalendars) {
			const isEnabled = this.plugin.settings.enabledCalendars.includes(cal.id);
			const calSetting = new Setting(this.calendarListContainer)
				.setName(`${cal.name}${cal.isPrimary ? ' (primary)' : ''}`)
				.setDesc(cal.id)
				.addColorPicker(picker => {
						const customColor = this.plugin.settings.calendarColors?.[cal.id];
						picker.setValue(customColor || cal.color || '#4285F4');
						picker.onChange(async (value) => {
							if (!this.plugin.settings.calendarColors) {
								this.plugin.settings.calendarColors = {};
							}
							this.plugin.settings.calendarColors[cal.id] = value;
							await this.plugin.saveSettings();
						});
					})
					.addToggle(toggle => toggle
					.setValue(isEnabled)
					.onChange(async (value) => {
						if (value) {
							if (!this.plugin.settings.enabledCalendars.includes(cal.id)) {
								this.plugin.settings.enabledCalendars.push(cal.id);
							}
						} else {
							this.plugin.settings.enabledCalendars =
								this.plugin.settings.enabledCalendars.filter(id => id !== cal.id);
							// If the disabled calendar was the default, clear the default
							if (this.plugin.settings.defaultCalendarId === cal.id) {
								this.plugin.settings.defaultCalendarId = '';
							}
						}
						await this.plugin.saveSettings();
						this.renderDefaultCalendarDropdown();
					}));

			// Append the custom-properties textarea to the same setting element so it
			// stays visually grouped with the calendar toggle (no separator line between).
			calSetting.settingEl.style.flexWrap = 'wrap';
			calSetting.settingEl.createEl('p', {
				text: 'Custom properties — added to every note from this calendar. One key = value pair per line.',
				cls: 'setting-item-description',
			}).style.width = '100%';
			const ta = calSetting.settingEl.createEl('textarea', {
				attr: {
					placeholder: 'categories = [[Events]], [[Birthdays]]\ntags = #Work',
					rows: '3',
					spellcheck: 'false',
				},
			});
			ta.addClass('gcal-sync-custom-props-ta');
			ta.value = this.plugin.settings.calendarCustomProperties?.[cal.id] ?? '';
			ta.addEventListener('change', async () => {
				if (!this.plugin.settings.calendarCustomProperties) {
					this.plugin.settings.calendarCustomProperties = {};
				}
				this.plugin.settings.calendarCustomProperties[cal.id] = ta.value;
				await this.plugin.saveSettings();
			});
		}

		this.renderDefaultCalendarDropdown();
	}

	private renderDefaultCalendarDropdown(): void {
		if (!this.defaultCalendarContainer) return;
		this.defaultCalendarContainer.empty();

		const enabledCalendars = this.availableCalendars.filter(cal =>
			this.plugin.settings.enabledCalendars.includes(cal.id)
		);

		if (enabledCalendars.length === 0) return;

		// Ensure the stored default is still valid; if not, reset to first enabled
		if (this.plugin.settings.defaultCalendarId &&
			!enabledCalendars.find(c => c.id === this.plugin.settings.defaultCalendarId)) {
			this.plugin.settings.defaultCalendarId = enabledCalendars[0].id;
			this.plugin.saveSettings();
		}

		new Setting(this.defaultCalendarContainer)
			.setName('Default calendar for new events')
			.setDesc('Calendar used when creating new events from Obsidian. Only enabled calendars appear here.')
			.addDropdown(dd => {
				for (const cal of enabledCalendars) {
					dd.addOption(cal.id, cal.name);
				}
				dd.setValue(this.plugin.settings.defaultCalendarId || enabledCalendars[0].id);
				dd.onChange(async (value) => {
					this.plugin.settings.defaultCalendarId = value;
					await this.plugin.saveSettings();
				});
			});
	}
}
