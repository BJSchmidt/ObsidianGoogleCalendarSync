import {
	BasesView,
	BasesPropertyOption,
	BasesAllOptions,
	BasesViewConfig,
	BasesEntry,
	QueryController,
	Value,
	DateValue,
	NullValue,
	TFile,
} from 'obsidian';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CalendarEvent {
	title: string;
	date: string;      // YYYY-MM-DD
	startTime: string;  // HH:MM or ''
	endTime: string;    // HH:MM or ''
	allDay: boolean;
	file: TFile;
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

	const events: CalendarEvent[] = [];
	for (const entry of view.data.data) {
		const dateVal = valueToString(entry.getValue(dateProp));
		if (!dateVal) continue;

		// Normalize date to YYYY-MM-DD (handles DateValue toString which may include time)
		const dateStr = dateVal.slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

		events.push({
			title: valueToString(entry.getValue(titleProp)) || entry.file.basename,
			date: dateStr,
			startTime: valueToString(entry.getValue(startTimeProp)),
			endTime: valueToString(entry.getValue(endTimeProp)),
			allDay: valueToString(entry.getValue(allDayProp)) === 'true',
			file: entry.file,
		});
	}
	return events;
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
	];
}

// Group events by date string
function groupByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
	const map = new Map<string, CalendarEvent[]>();
	for (const ev of events) {
		const list = map.get(ev.date) ?? [];
		list.push(ev);
		map.set(ev.date, list);
	}
	// Sort each day's events by start time
	for (const [, list] of map) {
		list.sort((a, b) => (a.startTime || '00:00').localeCompare(b.startTime || '00:00'));
	}
	return map;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
];

function formatDateKey(y: number, m: number, d: number): string {
	return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function todayKey(): string {
	const d = new Date();
	return formatDateKey(d.getFullYear(), d.getMonth(), d.getDate());
}

// Render a single event pill
function renderEventPill(container: HTMLElement, ev: CalendarEvent, openFile: (file: TFile) => void): void {
	const pill = container.createDiv({ cls: 'cal-view-event' });
	if (ev.startTime && !ev.allDay) {
		pill.createSpan({ cls: 'cal-view-event-time', text: ev.startTime });
	}
	pill.createSpan({ cls: 'cal-view-event-title', text: ev.title });
	pill.addEventListener('click', (e) => {
		e.stopPropagation();
		openFile(ev.file);
	});
}

// ---------------------------------------------------------------------------
// Month Calendar View
// ---------------------------------------------------------------------------

export class MonthCalendarView extends BasesView {
	type = 'cal-month';
	private containerEl: HTMLElement;
	private currentYear: number;
	private currentMonth: number; // 0-indexed

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.containerEl = containerEl;
		const now = new Date();
		this.currentYear = now.getFullYear();
		this.currentMonth = now.getMonth();
	}

	onDataUpdated(): void {
		this.render();
	}

	private render(): void {
		this.containerEl.empty();
		this.containerEl.addClass('cal-view-month');

		const events = extractEvents(this);
		const byDate = groupByDate(events);
		const today = todayKey();

		// Header with nav
		const header = this.containerEl.createDiv({ cls: 'cal-view-header' });
		const prevBtn = header.createEl('button', { cls: 'cal-view-nav-btn', text: '‹' });
		prevBtn.addEventListener('click', () => { this.prevMonth(); });
		header.createSpan({ cls: 'cal-view-title', text: `${MONTH_NAMES[this.currentMonth]} ${this.currentYear}` });
		const nextBtn = header.createEl('button', { cls: 'cal-view-nav-btn', text: '›' });
		nextBtn.addEventListener('click', () => { this.nextMonth(); });
		const todayBtn = header.createEl('button', { cls: 'cal-view-today-btn', text: 'Today' });
		todayBtn.addEventListener('click', () => {
			const now = new Date();
			this.currentYear = now.getFullYear();
			this.currentMonth = now.getMonth();
			this.render();
		});

		// Day-of-week headers
		const grid = this.containerEl.createDiv({ cls: 'cal-view-grid cal-view-grid-month' });
		for (const day of DAY_NAMES) {
			grid.createDiv({ cls: 'cal-view-day-header', text: day });
		}

		// Calendar cells
		const firstDay = new Date(this.currentYear, this.currentMonth, 1).getDay();
		const daysInMonth = new Date(this.currentYear, this.currentMonth + 1, 0).getDate();
		const daysInPrevMonth = new Date(this.currentYear, this.currentMonth, 0).getDate();

		// Previous month padding
		for (let i = firstDay - 1; i >= 0; i--) {
			const d = daysInPrevMonth - i;
			const prevMonth = this.currentMonth - 1;
			const prevYear = prevMonth < 0 ? this.currentYear - 1 : this.currentYear;
			const pm = prevMonth < 0 ? 11 : prevMonth;
			const key = formatDateKey(prevYear, pm, d);
			this.renderDayCell(grid, d, key, byDate.get(key) ?? [], true, key === today);
		}

		// Current month days
		for (let d = 1; d <= daysInMonth; d++) {
			const key = formatDateKey(this.currentYear, this.currentMonth, d);
			this.renderDayCell(grid, d, key, byDate.get(key) ?? [], false, key === today);
		}

		// Next month padding (fill to complete last row)
		const totalCells = firstDay + daysInMonth;
		const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
		for (let d = 1; d <= remaining; d++) {
			const nextMonth = this.currentMonth + 1;
			const nextYear = nextMonth > 11 ? this.currentYear + 1 : this.currentYear;
			const nm = nextMonth > 11 ? 0 : nextMonth;
			const key = formatDateKey(nextYear, nm, d);
			this.renderDayCell(grid, d, key, byDate.get(key) ?? [], true, key === today);
		}
	}

	private renderDayCell(
		grid: HTMLElement, dayNum: number, dateKey: string,
		events: CalendarEvent[], isOtherMonth: boolean, isToday: boolean
	): void {
		const cls = ['cal-view-day-cell'];
		if (isOtherMonth) cls.push('cal-view-other-month');
		if (isToday) cls.push('cal-view-today');
		const cell = grid.createDiv({ cls: cls.join(' ') });

		cell.createDiv({ cls: 'cal-view-day-number', text: String(dayNum) });

		const eventsContainer = cell.createDiv({ cls: 'cal-view-day-events' });
		const maxShow = 3;
		for (let i = 0; i < Math.min(events.length, maxShow); i++) {
			renderEventPill(eventsContainer, events[i], (f) => this.app.workspace.openLinkText(f.path, '', false));
		}
		if (events.length > maxShow) {
			eventsContainer.createDiv({ cls: 'cal-view-more', text: `+${events.length - maxShow} more` });
		}
	}

	private prevMonth(): void {
		this.currentMonth--;
		if (this.currentMonth < 0) { this.currentMonth = 11; this.currentYear--; }
		this.render();
	}

	private nextMonth(): void {
		this.currentMonth++;
		if (this.currentMonth > 11) { this.currentMonth = 0; this.currentYear++; }
		this.render();
	}
}

// ---------------------------------------------------------------------------
// Week Calendar View
// ---------------------------------------------------------------------------

export class WeekCalendarView extends BasesView {
	type = 'cal-week';
	private containerEl: HTMLElement;
	private weekStart: Date; // Sunday of the current week

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.containerEl = containerEl;
		this.weekStart = this.getWeekStart(new Date());
	}

	onDataUpdated(): void {
		this.render();
	}

	private getWeekStart(date: Date): Date {
		const d = new Date(date);
		d.setDate(d.getDate() - d.getDay());
		d.setHours(0, 0, 0, 0);
		return d;
	}

	private render(): void {
		this.containerEl.empty();
		this.containerEl.addClass('cal-view-week');

		const events = extractEvents(this);
		const byDate = groupByDate(events);
		const today = todayKey();

		// Header with nav
		const header = this.containerEl.createDiv({ cls: 'cal-view-header' });
		const prevBtn = header.createEl('button', { cls: 'cal-view-nav-btn', text: '‹' });
		prevBtn.addEventListener('click', () => { this.prevWeek(); });

		const weekEnd = new Date(this.weekStart);
		weekEnd.setDate(weekEnd.getDate() + 6);
		const startLabel = `${MONTH_NAMES[this.weekStart.getMonth()]} ${this.weekStart.getDate()}`;
		const endLabel = this.weekStart.getMonth() === weekEnd.getMonth()
			? `${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
			: `${MONTH_NAMES[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
		header.createSpan({ cls: 'cal-view-title', text: `${startLabel} – ${endLabel}` });

		const nextBtn = header.createEl('button', { cls: 'cal-view-nav-btn', text: '›' });
		nextBtn.addEventListener('click', () => { this.nextWeek(); });
		const todayBtn = header.createEl('button', { cls: 'cal-view-today-btn', text: 'Today' });
		todayBtn.addEventListener('click', () => {
			this.weekStart = this.getWeekStart(new Date());
			this.render();
		});

		// Day columns
		const grid = this.containerEl.createDiv({ cls: 'cal-view-grid cal-view-grid-week' });
		for (let i = 0; i < 7; i++) {
			const d = new Date(this.weekStart);
			d.setDate(d.getDate() + i);
			const key = formatDateKey(d.getFullYear(), d.getMonth(), d.getDate());
			const isToday = key === today;

			const col = grid.createDiv({ cls: `cal-view-week-col${isToday ? ' cal-view-today' : ''}` });
			col.createDiv({
				cls: 'cal-view-week-day-header',
				text: `${DAY_NAMES[d.getDay()]} ${d.getDate()}`,
			});

			const eventsContainer = col.createDiv({ cls: 'cal-view-day-events' });
			for (const ev of byDate.get(key) ?? []) {
				renderEventPill(eventsContainer, ev, (f) => this.app.workspace.openLinkText(f.path, '', false));
			}
		}
	}

	private prevWeek(): void {
		this.weekStart.setDate(this.weekStart.getDate() - 7);
		this.render();
	}

	private nextWeek(): void {
		this.weekStart.setDate(this.weekStart.getDate() + 7);
		this.render();
	}
}

// ---------------------------------------------------------------------------
// 3-Day Calendar View
// ---------------------------------------------------------------------------

export class ThreeDayCalendarView extends BasesView {
	type = 'cal-3day';
	private containerEl: HTMLElement;
	private startDate: Date;

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.containerEl = containerEl;
		this.startDate = new Date();
		this.startDate.setHours(0, 0, 0, 0);
	}

	onDataUpdated(): void {
		this.render();
	}

	private render(): void {
		this.containerEl.empty();
		this.containerEl.addClass('cal-view-3day');

		const events = extractEvents(this);
		const byDate = groupByDate(events);
		const today = todayKey();

		// Header with nav
		const header = this.containerEl.createDiv({ cls: 'cal-view-header' });
		const prevBtn = header.createEl('button', { cls: 'cal-view-nav-btn', text: '‹' });
		prevBtn.addEventListener('click', () => { this.shift(-3); });

		const endDate = new Date(this.startDate);
		endDate.setDate(endDate.getDate() + 2);
		const startLabel = `${MONTH_NAMES[this.startDate.getMonth()]} ${this.startDate.getDate()}`;
		const endLabel = this.startDate.getMonth() === endDate.getMonth()
			? `${endDate.getDate()}, ${endDate.getFullYear()}`
			: `${MONTH_NAMES[endDate.getMonth()]} ${endDate.getDate()}, ${endDate.getFullYear()}`;
		header.createSpan({ cls: 'cal-view-title', text: `${startLabel} – ${endLabel}` });

		const nextBtn = header.createEl('button', { cls: 'cal-view-nav-btn', text: '›' });
		nextBtn.addEventListener('click', () => { this.shift(3); });
		const todayBtn = header.createEl('button', { cls: 'cal-view-today-btn', text: 'Today' });
		todayBtn.addEventListener('click', () => {
			this.startDate = new Date();
			this.startDate.setHours(0, 0, 0, 0);
			this.render();
		});

		// 3 day columns
		const grid = this.containerEl.createDiv({ cls: 'cal-view-grid cal-view-grid-3day' });
		for (let i = 0; i < 3; i++) {
			const d = new Date(this.startDate);
			d.setDate(d.getDate() + i);
			const key = formatDateKey(d.getFullYear(), d.getMonth(), d.getDate());
			const isToday = key === today;

			const col = grid.createDiv({ cls: `cal-view-week-col${isToday ? ' cal-view-today' : ''}` });
			col.createDiv({
				cls: 'cal-view-week-day-header',
				text: `${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`,
			});

			const eventsContainer = col.createDiv({ cls: 'cal-view-day-events' });
			for (const ev of byDate.get(key) ?? []) {
				renderEventPill(eventsContainer, ev, (f) => this.app.workspace.openLinkText(f.path, '', false));
			}
		}
	}

	private shift(days: number): void {
		this.startDate.setDate(this.startDate.getDate() + days);
		this.render();
	}
}

// ---------------------------------------------------------------------------
// Shared options factory
// ---------------------------------------------------------------------------

export { getViewOptions };
