import { App, Modal, Notice, Setting } from 'obsidian';
import { GoogleCalendarListEntry, GoogleCalendarSyncSettings, NewEventFormData } from './types';
import { MultiValueInput, TagSuggest, PeopleSuggest } from './multiSuggest';

export class CalendarEventModal extends Modal {
	private formData: NewEventFormData;
	private startTimeSetting: Setting;
	private endTimeSetting: Setting;
	private endDateSetting: Setting;
	private tagsInput: MultiValueInput;
	private peopleInput: MultiValueInput;
	private onSubmit: (data: NewEventFormData) => void;
	private isEdit: boolean;
	private use12h: boolean;

	constructor(
		app: App,
		private enabledCalendars: GoogleCalendarListEntry[],
		defaultCalendarId: string,
		onSubmit: (data: NewEventFormData) => void,
		initialData?: NewEventFormData,
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.isEdit = !!initialData;

		// Read time format from plugin settings
		const plugin = (app as any).plugins?.plugins?.['google-calendar-sync'];
		const settings: GoogleCalendarSyncSettings | undefined = plugin?.settings;
		this.use12h = (settings?.timeFormat ?? '12h') === '12h';

		if (initialData) {
			this.formData = { ...initialData };
		} else {
			const defaultCal = enabledCalendars.find(c => c.id === defaultCalendarId)
				|| enabledCalendars[0];

			this.formData = {
				title: '',
				date: new Date().toISOString().slice(0, 10),
				startTime: '',
				endTime: '',
				endDate: '',
				allDay: false,
				calendarId: defaultCal?.id ?? 'primary',
				calendarName: defaultCal?.name ?? 'Primary',
				location: '',
				description: '',
				tags: [],
				people: [],
			};
		}
	}

	/** Convert 24h HH:MM to 12h display string. */
	private to12h(time: string): string {
		if (!time || !this.use12h) return time;
		const match = time.match(/^(\d{1,2}):(\d{2})$/);
		if (!match) return time;
		let h = parseInt(match[1]);
		const m = match[2];
		const ampm = h >= 12 ? 'PM' : 'AM';
		if (h === 0) h = 12;
		else if (h > 12) h -= 12;
		return `${h}:${m} ${ampm}`;
	}

	/** Parse user input (12h or 24h) to 24h HH:MM for storage. */
	private parse24h(input: string): string {
		const trimmed = input.trim();
		// Already 24h
		const match24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
		if (match24 && !this.use12h) return trimmed;
		if (match24 && this.use12h) {
			// Could be 24h input in 12h mode — accept it as-is if valid
			const h = parseInt(match24[1]);
			if (h >= 0 && h <= 23) return `${String(h).padStart(2, '0')}:${match24[2]}`;
		}
		// 12h format: "2:30 PM", "11:00 AM", etc.
		const match12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)$/i);
		if (match12) {
			let h = parseInt(match12[1]);
			const m = match12[2];
			const isPM = match12[3].toUpperCase() === 'PM';
			if (isPM && h !== 12) h += 12;
			if (!isPM && h === 12) h = 0;
			return `${String(h).padStart(2, '0')}:${m}`;
		}
		return trimmed; // Return as-is if we can't parse
	}

	onOpen(): void {
		this.modalEl.addClass('cal-create-event-modal');
		this.setTitle(this.isEdit ? 'Edit Calendar Event' : 'New Calendar Event');

		const { contentEl } = this;
		const timePlaceholder = this.use12h ? '12:00 PM' : 'HH:MM';

		// Title (wide)
		const titleSetting = new Setting(contentEl)
			.setName('Title')
			.addText(text => text
				.setPlaceholder('Event title')
				.setValue(this.formData.title)
				.onChange(v => { this.formData.title = v; }));
		titleSetting.controlEl.addClass('cal-modal-wide-control');

		// Date (native date picker)
		const dateSetting = new Setting(contentEl).setName('Date');
		const dateInput = dateSetting.controlEl.createEl('input', {
			type: 'date',
			cls: 'cal-modal-date-input',
		});
		dateInput.value = this.formData.date;
		dateInput.addEventListener('change', () => {
			this.formData.date = dateInput.value;
		});

		// All-day toggle
		new Setting(contentEl)
			.setName('All day')
			.addToggle(toggle => toggle
				.setValue(this.formData.allDay)
				.onChange(v => {
					this.formData.allDay = v;
					const display = v ? 'none' : '';
					this.startTimeSetting.settingEl.style.display = display;
					this.endTimeSetting.settingEl.style.display = display;
					this.endDateSetting.settingEl.style.display = display;
					if (v) {
						this.formData.startTime = '';
						this.formData.endTime = '';
						this.formData.endDate = '';
					}
				}));

		// Start time
		this.startTimeSetting = new Setting(contentEl)
			.setName('Start time')
			.addText(text => text
				.setPlaceholder(timePlaceholder)
				.setValue(this.to12h(this.formData.startTime))
				.onChange(v => { this.formData.startTime = this.parse24h(v); }));

		// End time
		this.endTimeSetting = new Setting(contentEl)
			.setName('End time')
			.addText(text => text
				.setPlaceholder(timePlaceholder)
				.setValue(this.to12h(this.formData.endTime))
				.onChange(v => { this.formData.endTime = this.parse24h(v); }));

		// End date (native date picker, for multi-day timed events)
		this.endDateSetting = new Setting(contentEl).setName('End date');
		const endDateInput = this.endDateSetting.controlEl.createEl('input', {
			type: 'date',
			cls: 'cal-modal-date-input',
		});
		endDateInput.value = this.formData.endDate ?? '';
		endDateInput.addEventListener('change', () => {
			this.formData.endDate = endDateInput.value;
		});

		// Hide time/end-date fields if all-day
		if (this.formData.allDay) {
			this.startTimeSetting.settingEl.style.display = 'none';
			this.endTimeSetting.settingEl.style.display = 'none';
			this.endDateSetting.settingEl.style.display = 'none';
		}

		// Calendar (always show — useful for setting default)
		new Setting(contentEl)
			.setName('Calendar')
			.addDropdown(dropdown => {
				for (const cal of this.enabledCalendars) {
					dropdown.addOption(cal.id, cal.name);
				}
				dropdown.setValue(this.formData.calendarId);
				dropdown.onChange(id => {
					this.formData.calendarId = id;
					const match = this.enabledCalendars.find(c => c.id === id);
					this.formData.calendarName = match?.name ?? 'Primary';
				});
			});

		// Location (wide)
		const locationSetting = new Setting(contentEl)
			.setName('Location')
			.addText(text => text
				.setPlaceholder('Location')
				.setValue(this.formData.location)
				.onChange(v => { this.formData.location = v; }));
		locationSetting.controlEl.addClass('cal-modal-wide-control');

		// Tags (wide)
		const tagsSetting = new Setting(contentEl).setName('Tags');
		tagsSetting.controlEl.addClass('cal-modal-wide-control');
		this.tagsInput = new MultiValueInput(
			this.app,
			tagsSetting.controlEl,
			(app, inputEl, onSelect) => new TagSuggest(app, inputEl, onSelect),
			{ placeholder: 'Add tags...', chipClass: 'tag', chipPrefix: '#' },
		);
		if (this.formData.tags.length > 0) {
			this.tagsInput.setValues(this.formData.tags);
		}

		// People (wide, pill style)
		const peopleSetting = new Setting(contentEl).setName('People');
		peopleSetting.controlEl.addClass('cal-modal-wide-control');
		this.peopleInput = new MultiValueInput(
			this.app,
			peopleSetting.controlEl,
			(app, inputEl, onSelect) => new PeopleSuggest(app, inputEl, onSelect),
			{ placeholder: 'Add people...', chipClass: 'cal-multi-chip', chipPrefix: '' },
		);
		if (this.formData.people.length > 0) {
			this.peopleInput.setValues(this.formData.people);
		}

		// Description (wide)
		const descSetting = new Setting(contentEl)
			.setName('Description')
			.addTextArea(text => text
				.setPlaceholder('Event description')
				.setValue(this.formData.description)
				.onChange(v => { this.formData.description = v; }));
		descSetting.controlEl.addClass('cal-modal-wide-control');

		// Submit button
		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText(this.isEdit ? 'Save changes' : 'Create event')
				.setCta()
				.onClick(() => this.submit()));

		// Auto-focus the title input
		const titleInput = contentEl.querySelector<HTMLInputElement>('input[type="text"]');
		titleInput?.focus();
	}

	private submit(): void {
		if (!this.formData.title.trim()) {
			new Notice('Please enter an event title.');
			return;
		}
		if (!this.formData.date.trim()) {
			new Notice('Please enter a date.');
			return;
		}
		if (!this.formData.allDay && !this.formData.startTime.trim()) {
			new Notice('Please enter a start time, or mark as all-day.');
			return;
		}
		this.formData.tags = this.tagsInput.getValues();
		this.formData.people = this.peopleInput.getValues();
		this.onSubmit(this.formData);
		this.close();
	}

	onClose(): void {
		this.tagsInput?.destroy();
		this.peopleInput?.destroy();
	}
}
