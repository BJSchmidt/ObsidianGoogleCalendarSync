import { App, Modal, Notice, Setting } from 'obsidian';
import { GoogleCalendarListEntry, NewEventFormData } from './types';
import { MultiValueInput, TagSuggest, PeopleSuggest } from './multiSuggest';

export class CalendarEventModal extends Modal {
	private formData: NewEventFormData;
	private startTimeSetting: Setting;
	private endTimeSetting: Setting;
	private tagsInput: MultiValueInput;
	private peopleInput: MultiValueInput;
	private onSubmit: (data: NewEventFormData) => void;
	private isEdit: boolean;

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

	onOpen(): void {
		this.modalEl.addClass('cal-create-event-modal');
		this.setTitle(this.isEdit ? 'Edit Calendar Event' : 'New Calendar Event');

		const { contentEl } = this;

		// Title
		new Setting(contentEl)
			.setName('Title')
			.addText(text => text
				.setPlaceholder('Event title')
				.setValue(this.formData.title)
				.onChange(v => { this.formData.title = v; }));

		// Date
		new Setting(contentEl)
			.setName('Date')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD')
				.setValue(this.formData.date)
				.onChange(v => { this.formData.date = v; }));

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
					if (v) {
						this.formData.startTime = '';
						this.formData.endTime = '';
					}
				}));

		// Start time
		this.startTimeSetting = new Setting(contentEl)
			.setName('Start time')
			.addText(text => text
				.setPlaceholder('HH:MM')
				.setValue(this.formData.startTime)
				.onChange(v => { this.formData.startTime = v; }));

		// End time
		this.endTimeSetting = new Setting(contentEl)
			.setName('End time')
			.addText(text => text
				.setPlaceholder('HH:MM')
				.setValue(this.formData.endTime)
				.onChange(v => { this.formData.endTime = v; }));

		// Hide time fields if all-day
		if (this.formData.allDay) {
			this.startTimeSetting.settingEl.style.display = 'none';
			this.endTimeSetting.settingEl.style.display = 'none';
		}

		// Calendar
		if (this.enabledCalendars.length > 1) {
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
		}

		// Location
		new Setting(contentEl)
			.setName('Location')
			.addText(text => text
				.setPlaceholder('Location')
				.setValue(this.formData.location)
				.onChange(v => { this.formData.location = v; }));

		// Tags
		const tagsSetting = new Setting(contentEl).setName('Tags');
		this.tagsInput = new MultiValueInput(
			this.app,
			tagsSetting.controlEl,
			(app, inputEl, onSelect) => new TagSuggest(app, inputEl, onSelect),
			'Add tag...',
		);
		if (this.formData.tags.length > 0) {
			this.tagsInput.setValues(this.formData.tags);
		}

		// People
		const peopleSetting = new Setting(contentEl).setName('People');
		this.peopleInput = new MultiValueInput(
			this.app,
			peopleSetting.controlEl,
			(app, inputEl, onSelect) => new PeopleSuggest(app, inputEl, onSelect),
			'Add person...',
		);
		if (this.formData.people.length > 0) {
			this.peopleInput.setValues(this.formData.people);
		}

		// Description
		new Setting(contentEl)
			.setName('Description')
			.addTextArea(text => text
				.setPlaceholder('Event description')
				.setValue(this.formData.description)
				.onChange(v => { this.formData.description = v; }));

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
