import {
	BasesView,
	BasesAllOptions,
	BasesViewConfig,
	BasesEntry,
	QueryController,
	Value,
	NullValue,
	TFile,
} from 'obsidian';
import Calendar from '@toast-ui/calendar';
import type { EventObject, Options } from '@toast-ui/calendar';

// TUI Calendar CSS is injected at runtime via loadTuiCss() called from main.ts onload().
// esbuild's `loader: { ".css": "text" }` inlines the CSS as a string.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TUI_CSS: string = require('@toast-ui/calendar/dist/toastui-calendar.min.css');

let tuiCssInjected = false;
export function loadTuiCss(): void {
	if (tuiCssInjected) return;
	tuiCssInjected = true;
	const style = document.createElement('style');
	style.id = 'cal-tui-calendar-css';
	style.textContent = TUI_CSS;
	document.head.appendChild(style);
}

export function unloadTuiCss(): void {
	document.getElementById('cal-tui-calendar-css')?.remove();
	tuiCssInjected = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CalendarEvent {
	id: string;
	title: string;
	date: string;       // YYYY-MM-DD
	startTime: string;  // HH:MM or ''
	endTime: string;    // HH:MM or ''
	allDay: boolean;
	file: TFile;
	calendarName: string;
}

function valueToString(v: Value | null): string {
	if (!v || v instanceof NullValue) return '';
	return v.toString();
}

function extractEvents(view: BasesView): CalendarEvent[] {
	const config = view.config;
	const dateProp = config.getAsPropertyId('dateProp') ?? 'note.date';
	const titleProp = config.getAsPropertyId('titleProp') ?? 'note.title';
	const startTimeProp = config.getAsPropertyId('startTimeProp') ?? 'note.startTime';
	const endTimeProp = config.getAsPropertyId('endTimeProp') ?? 'note.endTime';
	const allDayProp = config.getAsPropertyId('allDayProp') ?? 'note.allDay';
	const calendarProp = config.getAsPropertyId('calendarProp') ?? 'note.cal-calendar';

	const events: CalendarEvent[] = [];
	for (const entry of view.data.data) {
		const dateVal = valueToString(entry.getValue(dateProp));
		if (!dateVal) continue;

		const dateStr = dateVal.slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

		events.push({
			id: entry.file.path,
			title: valueToString(entry.getValue(titleProp)) || entry.file.basename,
			date: dateStr,
			startTime: valueToString(entry.getValue(startTimeProp)),
			endTime: valueToString(entry.getValue(endTimeProp)),
			allDay: valueToString(entry.getValue(allDayProp)) === 'true',
			file: entry.file,
			calendarName: valueToString(entry.getValue(calendarProp)),
		});
	}
	return events;
}

// Normalize a time string to 24h HH:MM format.
// Handles: "09:00", "9:00 AM", "2:30 PM", "14:00", etc.
function normalizeTo24h(time: string): string {
	const t = time.trim();
	// Already 24h format (HH:MM or H:MM)
	const match24 = t.match(/^(\d{1,2}):(\d{2})$/);
	if (match24) {
		return `${match24[1].padStart(2, '0')}:${match24[2]}`;
	}
	// 12h format (H:MM AM/PM)
	const match12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
	if (match12) {
		let h = parseInt(match12[1], 10);
		const m = match12[2];
		const period = match12[3].toUpperCase();
		if (period === 'PM' && h !== 12) h += 12;
		if (period === 'AM' && h === 12) h = 0;
		return `${String(h).padStart(2, '0')}:${m}`;
	}
	return t;
}

function toTuiEvents(events: CalendarEvent[]): EventObject[] {
	return events.map(ev => {
		if (ev.allDay || !ev.startTime) {
			return {
				id: ev.id,
				calendarId: 'default',
				title: ev.title,
				start: `${ev.date}T00:00:00`,
				end: `${ev.date}T23:59:59`,
				isAllday: true,
				category: 'allday',
				raw: { file: ev.file },
			};
		}

		const startTime = normalizeTo24h(ev.startTime);
		const endTime = ev.endTime ? normalizeTo24h(ev.endTime) : startTime;
		return {
			id: ev.id,
			calendarId: 'default',
			title: ev.title,
			start: `${ev.date}T${startTime}:00`,
			end: `${ev.date}T${endTime}:00`,
			isAllday: false,
			category: 'time',
			raw: { file: ev.file },
		};
	});
}

function getViewOptions(config: BasesViewConfig): BasesAllOptions[] {
	return [
		{
			type: 'property' as const,
			key: 'dateProp',
			displayName: 'Date property',
			default: 'date',
		},
		{
			type: 'property' as const,
			key: 'titleProp',
			displayName: 'Title property',
			default: 'title',
		},
		{
			type: 'property' as const,
			key: 'startTimeProp',
			displayName: 'Start time property',
			default: 'startTime',
		},
		{
			type: 'property' as const,
			key: 'endTimeProp',
			displayName: 'End time property',
			default: 'endTime',
		},
		{
			type: 'property' as const,
			key: 'allDayProp',
			displayName: 'All-day property',
			default: 'allDay',
		},
		{
			type: 'property' as const,
			key: 'calendarProp',
			displayName: 'Calendar name property',
			default: 'cal-calendar',
		},
	];
}

// ---------------------------------------------------------------------------
// Shared TUI Calendar wrapper for Bases views
// ---------------------------------------------------------------------------

function getObsidianTheme(): 'dark' | 'light' {
	return document.body.classList.contains('theme-dark') ? 'dark' : 'light';
}

function getTuiTheme(): Options['theme'] {
	const isDark = getObsidianTheme() === 'dark';
	const style = getComputedStyle(document.body);
	const bgPrimary = style.getPropertyValue('--background-primary').trim() || (isDark ? '#1e1e1e' : '#ffffff');
	const bgSecondary = style.getPropertyValue('--background-secondary').trim() || (isDark ? '#262626' : '#f5f5f5');
	const textNormal = style.getPropertyValue('--text-normal').trim() || (isDark ? '#dcddde' : '#1a1a1a');
	const textMuted = style.getPropertyValue('--text-muted').trim() || (isDark ? '#999' : '#666');
	const accent = style.getPropertyValue('--interactive-accent').trim() || '#7b6cd9';
	const border = style.getPropertyValue('--background-modifier-border').trim() || (isDark ? '#333' : '#ddd');

	return {
		common: {
			backgroundColor: bgPrimary,
			border: `1px solid ${border}`,
			holiday: { color: textNormal },
			saturday: { color: textNormal },
			dayName: { color: textMuted },
			today: { color: accent },
			gridSelection: {
				backgroundColor: accent,
				border: `1px solid ${accent}`,
			},
		},
		week: {
			dayName: {
				borderLeft: `1px solid ${border}`,
				borderTop: `1px solid ${border}`,
				borderBottom: `1px solid ${border}`,
				backgroundColor: bgSecondary,
			},
			dayGrid: {
				borderRight: `1px solid ${border}`,
				backgroundColor: bgPrimary,
			},
			dayGridLeft: {
				borderRight: `1px solid ${border}`,
				backgroundColor: bgSecondary,
				width: '60px',
			},
			timeGrid: { borderRight: `1px solid ${border}` },
			timeGridLeft: {
				borderRight: `1px solid ${border}`,
				backgroundColor: bgSecondary,
				width: '60px',
			},
			timeGridHalfHourLine: { borderBottom: `1px dotted ${border}` },
			timeGridHourLine: { borderBottom: `1px solid ${border}` },
			nowIndicatorLabel: { color: accent },
			nowIndicatorPast: { border: `1px dashed ${accent}` },
			nowIndicatorBullet: { backgroundColor: accent },
			nowIndicatorToday: { border: `1px solid ${accent}` },
			pastTime: { color: textMuted },
			futureTime: { color: textNormal },
			panelResizer: { border: `1px solid ${border}` },
			gridSelection: { color: accent },
		},
		month: {
			dayExceptThisMonth: { color: textMuted },
			dayName: {
				borderLeft: `1px solid ${border}`,
				backgroundColor: bgSecondary,
			},
			holidayExceptThisMonth: { color: textMuted },
			moreView: {
				backgroundColor: bgPrimary,
				border: `1px solid ${border}`,
				boxShadow: `0 2px 6px rgba(0,0,0,0.2)`,
				width: 220,
				height: 200,
			},
			moreViewTitle: { backgroundColor: bgSecondary },
			weekend: { backgroundColor: bgPrimary },
		},
	};
}

abstract class BaseTuiCalendarView extends BasesView {
	protected containerEl: HTMLElement;
	protected calendar: Calendar | null = null;
	protected navEl: HTMLElement;
	protected calendarEl: HTMLElement;
	protected titleEl: HTMLElement;

	// Map of file paths for click handling
	private fileMap = new Map<string, TFile>();

	abstract getDefaultView(): 'month' | 'week' | 'day';

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.containerEl = containerEl;
	}

	onload(): void {
		this.containerEl.addClass('cal-view-container');

		// Navigation bar (we build our own since TUI doesn't include one)
		this.navEl = this.containerEl.createDiv({ cls: 'cal-view-header' });
		const prevBtn = this.navEl.createEl('button', { cls: 'cal-view-nav-btn', text: '‹' });
		prevBtn.addEventListener('click', () => { this.calendar?.prev(); this.updateTitle(); });
		this.titleEl = this.navEl.createSpan({ cls: 'cal-view-title' });
		const nextBtn = this.navEl.createEl('button', { cls: 'cal-view-nav-btn', text: '›' });
		nextBtn.addEventListener('click', () => { this.calendar?.next(); this.updateTitle(); });
		const todayBtn = this.navEl.createEl('button', { cls: 'cal-view-today-btn', text: 'Today' });
		todayBtn.addEventListener('click', () => { this.calendar?.today(); this.updateTitle(); });

		// Calendar container
		this.calendarEl = this.containerEl.createDiv({ cls: 'cal-view-tui-container' });

		this.calendar = new Calendar(this.calendarEl, {
			defaultView: this.getDefaultView(),
			usageStatistics: false,
			isReadOnly: true,
			useFormPopup: false,
			useDetailPopup: false,
			theme: getTuiTheme(),
			week: {
				startDayOfWeek: 0,
				taskView: false,
				eventView: ['allday', 'time'],
			},
			month: {
				startDayOfWeek: 0,
			},
		});

		// Handle event clicks — open the source note
		this.calendar.on('clickEvent', ({ event }) => {
			const file = this.fileMap.get(event.id);
			if (file) {
				this.app.workspace.openLinkText(file.path, '', false);
			}
		});

		this.updateTitle();
	}

	onunload(): void {
		this.calendar?.destroy();
		this.calendar = null;
	}

	onDataUpdated(): void {
		if (!this.calendar) return;

		const events = extractEvents(this);

		// Build file map for click handling
		this.fileMap.clear();
		for (const ev of events) {
			this.fileMap.set(ev.id, ev.file);
		}

		this.calendar.clear();
		this.calendar.createEvents(toTuiEvents(events));
		this.updateTitle();
	}

	private updateTitle(): void {
		if (!this.calendar) return;
		const date = this.calendar.getDate().toDate();
		const monthNames = [
			'January', 'February', 'March', 'April', 'May', 'June',
			'July', 'August', 'September', 'October', 'November', 'December',
		];

		const view = this.getDefaultView();
		if (view === 'month') {
			this.titleEl.setText(`${monthNames[date.getMonth()]} ${date.getFullYear()}`);
		} else {
			const start = this.calendar.getDateRangeStart().toDate();
			const end = this.calendar.getDateRangeEnd().toDate();
			const startLabel = `${monthNames[start.getMonth()]} ${start.getDate()}`;
			const endLabel = start.getMonth() === end.getMonth()
				? `${end.getDate()}, ${end.getFullYear()}`
				: `${monthNames[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
			this.titleEl.setText(`${startLabel} – ${endLabel}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Concrete view classes
// ---------------------------------------------------------------------------

export class MonthCalendarView extends BaseTuiCalendarView {
	type = 'cal-month';
	getDefaultView() { return 'month' as const; }
}

export class WeekCalendarView extends BaseTuiCalendarView {
	type = 'cal-week';
	getDefaultView() { return 'week' as const; }
}

export class ThreeDayCalendarView extends BaseTuiCalendarView {
	type = 'cal-3day';

	onload(): void {
		super.onload();
		// Configure for 3-day view by setting visibleWeeksCount on month
		// TUI doesn't have a native 3-day, so we use week view with narrowed range
		if (this.calendar) {
			this.calendar.setOptions({
				week: {
					startDayOfWeek: new Date().getDay(),
					taskView: false,
					eventView: ['allday', 'time'],
				},
			});
		}
	}

	getDefaultView() { return 'week' as const; }
}

// ---------------------------------------------------------------------------
// Shared options factory
// ---------------------------------------------------------------------------

export { getViewOptions };
