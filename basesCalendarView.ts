import {
	BasesView,
	BasesAllOptions,
	BasesViewConfig,
	BasesEntry,
	QueryController,
	Value,
	NullValue,
	TFile,
	Notice,
} from "obsidian";
import Calendar from "@toast-ui/calendar";
import type { EventObject, Options } from "@toast-ui/calendar";
import { CalendarEventModal } from "./createEventModal";
import type { NewEventFormData, GoogleCalendarListEntry } from "./types";

/** TZDate from TUI Calendar — has getHours/getMinutes like Date */
interface TZDateLike {
	getHours(): number;
	getMinutes(): number;
}

// TUI Calendar CSS is injected at runtime via loadTuiCss() called from main.ts onload().
// esbuild's `loader: { ".css": "text" }` inlines the CSS as a string.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TUI_CSS: string = require("@toast-ui/calendar/dist/toastui-calendar.min.css");

let tuiCssInjected = false;
export function loadTuiCss(): void {
	if (tuiCssInjected) return;
	tuiCssInjected = true;
	const style = document.createElement("style");
	style.id = "cal-tui-calendar-css";
	style.textContent = TUI_CSS;
	document.head.appendChild(style);
}

export function unloadTuiCss(): void {
	document.getElementById("cal-tui-calendar-css")?.remove();
	tuiCssInjected = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CalendarEvent {
	id: string;
	title: string;
	date: string; // YYYY-MM-DD
	startTime: string; // HH:MM or ''
	endTime: string; // HH:MM or ''
	allDay: boolean;
	file: TFile;
	calendarName: string;
}

function valueToString(v: Value | null): string {
	if (!v || v instanceof NullValue) return "";
	return v.toString();
}

function extractEvents(view: BasesView): CalendarEvent[] {
	const config = view.config;
	const dateProp = config.getAsPropertyId("dateProp") ?? "note.date";
	const titleProp = config.getAsPropertyId("titleProp") ?? "note.title";
	const startTimeProp =
		config.getAsPropertyId("startTimeProp") ?? "note.startTime";
	const endTimeProp = config.getAsPropertyId("endTimeProp") ?? "note.endTime";
	const allDayProp = config.getAsPropertyId("allDayProp") ?? "note.allDay";
	const calendarProp =
		config.getAsPropertyId("calendarProp") ?? "note.calendar";

	const events: CalendarEvent[] = [];
	for (const entry of view.data.data) {
		const dateVal = valueToString(entry.getValue(dateProp));
		if (!dateVal) continue;

		const dateStr = dateVal.slice(0, 10);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

		events.push({
			id: entry.file.path,
			title:
				valueToString(entry.getValue(titleProp)) || entry.file.basename,
			date: dateStr,
			startTime: valueToString(entry.getValue(startTimeProp)),
			endTime: valueToString(entry.getValue(endTimeProp)),
			allDay: valueToString(entry.getValue(allDayProp)) === "true",
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
		return `${match24[1].padStart(2, "0")}:${match24[2]}`;
	}
	// 12h format (H:MM AM/PM)
	const match12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
	if (match12) {
		let h = parseInt(match12[1], 10);
		const m = match12[2];
		const period = match12[3].toUpperCase();
		if (period === "PM" && h !== 12) h += 12;
		if (period === "AM" && h === 12) h = 0;
		return `${String(h).padStart(2, "0")}:${m}`;
	}
	return t;
}

// Default palette for calendars without a configured color.
// These are visually distinct and work in both light and dark themes.
const DEFAULT_PALETTE = [
	"#7b6cd9",
	"#4185f4",
	"#33a853",
	"#ea4335",
	"#fbbc04",
	"#ff6d01",
	"#46bdc6",
	"#e67c73",
	"#8e24aa",
	"#039be5",
];

function toTuiEvents(events: CalendarEvent[]): EventObject[] {
	return events.map((ev) => {
		const calId = ev.calendarName || "default";

		if (ev.allDay || !ev.startTime) {
			return {
				id: ev.id,
				calendarId: calId,
				title: ev.title,
				start: `${ev.date}T00:00:00`,
				end: `${ev.date}T23:59:59`,
				isAllday: true,
				category: "allday",
				raw: { file: ev.file },
			};
		}

		const startTime = normalizeTo24h(ev.startTime);
		const endTime = ev.endTime ? normalizeTo24h(ev.endTime) : startTime;
		return {
			id: ev.id,
			calendarId: calId,
			title: ev.title,
			start: `${ev.date}T${startTime}:00`,
			end: `${ev.date}T${endTime}:00`,
			isAllday: false,
			category: "time",
			raw: { file: ev.file },
		};
	});
}

// Build TUI CalendarInfo[] from the unique calendar names found in events,
// using Google Calendar colors from cachedCalendars when available.
function buildCalendarInfos(
	events: CalendarEvent[],
	cachedCalendars: Array<{ id: string; name: string; color: string }>,
	calendarColors: Record<string, string>,
): Array<{
	id: string;
	name: string;
	color: string;
	backgroundColor: string;
	borderColor: string;
	dragBackgroundColor: string;
}> {
	const names = new Set(events.map((ev) => ev.calendarName || "default"));
	// Build lookup: calendar name → { id, color }
	const cachedByName = new Map(
		cachedCalendars.map((c) => [c.name, { id: c.id, color: c.color }]),
	);
	let paletteIdx = 0;

	return Array.from(names).map((name) => {
		const cached = cachedByName.get(name);
		// Priority: user-chosen color > Google color > fallback palette
		const color =
			(cached && calendarColors[cached.id]) ||
			cached?.color ||
			DEFAULT_PALETTE[paletteIdx++ % DEFAULT_PALETTE.length];
		return {
			id: name,
			name,
			color: "#ffffff",
			backgroundColor: color,
			borderColor: color,
			dragBackgroundColor: color,
		};
	});
}

// Format an hour number for the time grid labels.
function formatHourLabel(hour: number, use12h: boolean): string {
	if (!use12h) return `${String(hour).padStart(2, "0")}:00`;
	if (hour === 0) return "12 AM";
	if (hour < 12) return `${hour} AM`;
	if (hour === 12) return "12 PM";
	return `${hour - 12} PM`;
}

// Format a Date/TZDate for event time display.
function formatEventTime(date: Date | TZDateLike, use12h: boolean): string {
	const h = date.getHours();
	const m = String(date.getMinutes()).padStart(2, "0");
	if (!use12h) return `${String(h).padStart(2, "0")}:${m}`;
	const period = h >= 12 ? "PM" : "AM";
	const h12 = h % 12 || 12;
	return `${h12}:${m} ${period}`;
}

/** Build TUI Calendar template functions for time format display. */
function buildTimeTemplates(use12h: boolean): Options["template"] {
	return {
		timegridDisplayPrimaryTime(props: any) {
			return formatHourLabel(props.time.getHours(), use12h);
		},
		timegridNowIndicatorLabel(props: any) {
			return formatEventTime(props.time, use12h);
		},
		time(event: any) {
			const timeStr = formatEventTime(event.start, use12h);
			return `${timeStr} ${event.title}`;
		},
	};
}

/** Add N days to a Date (returns new Date). */
function addDays(d: Date, n: number): Date {
	const r = new Date(d);
	r.setDate(r.getDate() + n);
	return r;
}

function getViewOptions(config: BasesViewConfig): BasesAllOptions[] {
	return [
		{
			type: "property" as const,
			key: "dateProp",
			displayName: "Date property",
			default: "date",
		},
		{
			type: "property" as const,
			key: "titleProp",
			displayName: "Title property",
			default: "title",
		},
		{
			type: "property" as const,
			key: "startTimeProp",
			displayName: "Start time property",
			default: "startTime",
		},
		{
			type: "property" as const,
			key: "endTimeProp",
			displayName: "End time property",
			default: "endTime",
		},
		{
			type: "property" as const,
			key: "allDayProp",
			displayName: "All-day property",
			default: "allDay",
		},
		{
			type: "property" as const,
			key: "calendarProp",
			displayName: "Calendar name property",
			default: "calendar",
		},
		{
			type: "dropdown" as const,
			key: "timeFormat",
			displayName: "Time format",
			default: "12h",
			options: {
				"12h": "12-hour (1:00 PM)",
				"24h": "24-hour (13:00)",
			} as Record<string, string>,
		},
	];
}

// ---------------------------------------------------------------------------
// Shared TUI Calendar wrapper for Bases views
// ---------------------------------------------------------------------------

/** Parse any CSS color (hex, rgb, hsl, etc.) to [r, g, b] using the browser. */
function parseColor(color: string): [number, number, number] {
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return [124, 108, 217]; // fallback
	ctx.fillStyle = color;
	const resolved = ctx.fillStyle; // browser normalizes to #rrggbb or rgba()
	if (resolved.startsWith("#")) {
		const h = resolved.slice(1);
		return [
			parseInt(h.slice(0, 2), 16),
			parseInt(h.slice(2, 4), 16),
			parseInt(h.slice(4, 6), 16),
		];
	}
	// rgba(r, g, b, a) or rgb(r, g, b)
	const m = resolved.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
	if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
	return [124, 108, 217]; // fallback
}

function getObsidianTheme(): "dark" | "light" {
	return document.body.classList.contains("theme-dark") ? "dark" : "light";
}

function getTuiTheme(): Options["theme"] {
	const isDark = getObsidianTheme() === "dark";
	const style = getComputedStyle(document.body);
	const bgPrimary =
		style.getPropertyValue("--background-primary").trim() ||
		(isDark ? "#1e1e1e" : "#ffffff");
	const bgSecondary =
		style.getPropertyValue("--background-secondary").trim() ||
		(isDark ? "#262626" : "#f5f5f5");
	const textNormal =
		style.getPropertyValue("--text-normal").trim() ||
		(isDark ? "#dcddde" : "#1a1a1a");
	const textMuted =
		style.getPropertyValue("--text-muted").trim() ||
		(isDark ? "#999" : "#666");
	const accent =
		style.getPropertyValue("--interactive-accent").trim() || "#7b6cd9";
	const border =
		style.getPropertyValue("--background-modifier-border").trim() ||
		(isDark ? "#333" : "#ddd");

	const [ar, ag, ab] = parseColor(accent);
	const weekendBg = "rgba(128, 128, 128, 0.05)";
	const todayBg = `rgba(${ar}, ${ag}, ${ab}, 0.10)`;

	return {
		common: {
			backgroundColor: bgPrimary,
			border: `1px solid ${border}`,
			holiday: { color: textMuted },
			saturday: { color: textMuted },
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
				backgroundColor: "transparent",
			},
			dayGridLeft: {
				borderRight: `1px solid ${border}`,
				backgroundColor: bgSecondary,
				width: "60px",
			},
			timeGrid: { borderRight: `1px solid ${border}` },
			timeGridLeft: {
				borderRight: `1px solid ${border}`,
				backgroundColor: bgSecondary,
				width: "60px",
			},
			// timeGridHalfHourLine: { borderBottom: `1px dotted ${border}` },
			timeGridHalfHourLine: { borderBottom: "none" },
			timeGridHourLine: { borderBottom: "none" },
			nowIndicatorLabel: { color: accent },
			nowIndicatorPast: { border: `1px dashed ${accent}` },
			nowIndicatorBullet: { backgroundColor: accent },
			nowIndicatorToday: { border: `1px solid ${accent}` },
			pastTime: { color: textMuted },
			pastDay: { color: textMuted },
			futureTime: { color: textNormal },
			panelResizer: { border: `1px solid ${border}` },
			gridSelection: { color: accent },
			weekend: { backgroundColor: weekendBg },
			today: { color: accent, backgroundColor: todayBg },
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
			weekend: { backgroundColor: weekendBg },
			today: { color: accent, backgroundColor: todayBg },
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

	// Anchor date used for custom-step navigation (lookahead views)
	protected anchorDate = new Date();

	// Track last time format to detect changes
	private lastTimeFormat: string | null = null;

	/** TUI Calendar view type: 'month' | 'week' | 'day' */
	abstract getDefaultView(): "month" | "week" | "day";

	/** First day of the week (0=Sun). Override to use today's weekday for lookahead views. */
	protected getWeekStartDay(): number {
		return 0;
	}

	/** Extra options merged into TUI month config. */
	protected getMonthOptions(): Record<string, unknown> {
		return {};
	}

	/**
	 * Number of days to advance/retreat on prev/next.
	 * null = use TUI Calendar's default navigation (1 month / 1 week / 1 day).
	 */
	protected getNavStepDays(): number | null {
		return null;
	}

	/** Extra CSS class added to the TUI container (e.g., for column-hiding). */
	protected getContainerClass(): string | null {
		return null;
	}

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.containerEl = containerEl;
	}

	onload(): void {
		this.containerEl.addClass("cal-view-container");

		// Navigation bar
		this.navEl = this.containerEl.createDiv({ cls: "cal-view-header" });
		const prevBtn = this.navEl.createEl("button", {
			cls: "cal-view-nav-btn",
			text: "‹",
		});
		prevBtn.addEventListener("click", () => this.navigate(-1));
		this.titleEl = this.navEl.createSpan({ cls: "cal-view-title" });
		const nextBtn = this.navEl.createEl("button", {
			cls: "cal-view-nav-btn",
			text: "›",
		});
		nextBtn.addEventListener("click", () => this.navigate(1));
		const todayBtn = this.navEl.createEl("button", {
			cls: "cal-view-today-btn",
			text: "Today",
		});
		todayBtn.addEventListener("click", () => this.goToToday());

		// Calendar container
		this.calendarEl = this.containerEl.createDiv({
			cls: "cal-view-tui-container",
		});
		const extraCls = this.getContainerClass();
		if (extraCls) this.calendarEl.addClass(extraCls);

		this.calendar = this.createCalendar(true);
		this.updateTitle();
	}

	/** Create a new TUI Calendar instance with the given time format. */
	private createCalendar(use12h: boolean): Calendar {
		const weekStartDay = this.getWeekStartDay();
		const cal = new Calendar(this.calendarEl, {
			defaultView: this.getDefaultView(),
			usageStatistics: false,
			isReadOnly: false,
			useFormPopup: false,
			useDetailPopup: false,
			gridSelection: true,
			timezone: {
				zones: [
					{
						timezoneName:
							Intl.DateTimeFormat().resolvedOptions().timeZone,
					},
				],
			},
			theme: getTuiTheme(),
			template: buildTimeTemplates(use12h),
			week: {
				startDayOfWeek: weekStartDay,
				taskView: false,
				eventView: ["allday", "time"],
			},
			month: {
				startDayOfWeek: weekStartDay,
				...this.getMonthOptions(),
			},
		});

		// Apply drag/resize changes to the TUI calendar view and persist to note
		cal.on("beforeUpdateEvent", ({ event, changes }) => {
			cal.updateEvent(event.id, event.calendarId, changes);
			this.persistEventUpdate(event.id, changes);
		});

		// Click event — open edit modal
		cal.on("clickEvent", ({ event }) => {
			const file = this.fileMap.get(event.id);
			if (file) {
				this.openEditModal(file);
			}
		});

		// Select time range — open create modal with pre-filled times
		cal.on("selectDateTime", ({ start, end, isAllday }) => {
			this.openCreateModal(start, end, isAllday);
			cal.clearGridSelections();
		});

		return cal;
	}

	/** Persist a drag/resize change to the note's frontmatter.
	 *  The two-way sync handler will detect the vault modify and push to Google. */
	private async persistEventUpdate(
		eventId: string,
		changes: EventObject,
	): Promise<void> {
		const file = this.fileMap.get(eventId);
		if (!file) return;

		try {
			await this.app.fileManager.processFrontMatter(file, (fm) => {
				if (changes.start) {
					const start = new Date(changes.start as any);
					fm["date"] = start.toISOString().slice(0, 10);
					if (!changes.isAllday && !fm["allDay"]) {
						fm["startTime"] = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
					}
				}
				if (changes.end) {
					const end = new Date(changes.end as any);
					fm["endDate"] = end.toISOString().slice(0, 10);
					if (!changes.isAllday && !fm["allDay"]) {
						fm["endTime"] = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
					}
				}
				if (changes.isAllday !== undefined) {
					fm["allDay"] = changes.isAllday;
					if (changes.isAllday) {
						delete fm["startTime"];
						delete fm["endTime"];
					}
				}
				if (changes.title !== undefined) {
					fm["title"] = changes.title;
				}
			});
		} catch (err) {
			console.error("[cal-view] Failed to persist event update:", err);
		}
	}

	/** Get enabled calendars and default calendar ID from plugin settings. */
	private getPluginCalendarInfo(): {
		calendars: GoogleCalendarListEntry[];
		defaultCalendarId: string;
		plugin: any;
	} {
		const plugin = (this.app as any).plugins?.plugins?.[
			"google-calendar-sync"
		];
		if (!plugin) {
			return { calendars: [], defaultCalendarId: "primary", plugin: null };
		}
		const settings = plugin.settings;
		let calendars: GoogleCalendarListEntry[] = (
			settings.cachedCalendars || []
		).filter((c: GoogleCalendarListEntry) =>
			settings.enabledCalendars.includes(c.id),
		);
		if (calendars.length === 0) {
			calendars = [
				{
					id: settings.defaultCalendarId || "primary",
					name: "Primary",
					color: "#4285F4",
					isPrimary: true,
					accessRole: "owner",
				},
			];
		}
		return {
			calendars,
			defaultCalendarId: settings.defaultCalendarId,
			plugin,
		};
	}

	/** Open the edit modal for an existing event note. */
	private async openEditModal(file: TFile): Promise<void> {
		const { calendars, defaultCalendarId, plugin } =
			this.getPluginCalendarInfo();
		if (!plugin) return;

		const content = await this.app.vault.read(file);
		const fm = plugin.noteManager?.parseFrontmatter(content) ?? {};

		const initialData: NewEventFormData = {
			title: String(fm["title"] ?? ""),
			date: String(fm["date"] ?? ""),
			startTime: String(fm["startTime"] ?? ""),
			endTime: String(fm["endTime"] ?? ""),
			endDate: String(fm["endDate"] ?? ""),
			allDay: Boolean(fm["allDay"] ?? false),
			calendarId: String(
				fm["cal-calendar-id"] ?? defaultCalendarId ?? "primary",
			),
			calendarName: String(fm["calendar"] ?? fm["cal-calendar"] ?? "Primary"),
			location: String(fm["cal-location"] ?? ""),
			description: String(fm["cal-description"] ?? ""),
			tags: Array.isArray(fm["tags"]) ? fm["tags"].map(String) : [],
			people: Array.isArray(fm["people"])
				? fm["people"].map(String)
				: [],
		};

		new CalendarEventModal(
			this.app,
			calendars,
			defaultCalendarId,
			async (formData) => {
				await plugin.updateEventFromModal(file, formData);
			},
			initialData,
		).open();
	}

	/** Open the create modal with pre-filled date/time from grid selection. */
	private openCreateModal(
		start: Date,
		end: Date,
		isAllday: boolean,
	): void {
		const { calendars, defaultCalendarId, plugin } =
			this.getPluginCalendarInfo();
		if (!plugin) return;

		const pad = (n: number) => String(n).padStart(2, "0");
		const dateStr = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;

		const endDateStr = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
		const initialData: NewEventFormData = {
			title: "",
			date: dateStr,
			startTime: isAllday
				? ""
				: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
			endTime: isAllday
				? ""
				: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
			endDate: dateStr !== endDateStr ? endDateStr : "",
			allDay: isAllday,
			calendarId: defaultCalendarId || "primary",
			calendarName:
				calendars.find(
					(c: GoogleCalendarListEntry) =>
						c.id === defaultCalendarId,
				)?.name ?? "Primary",
			location: "",
			description: "",
			tags: [],
			people: [],
		};

		new CalendarEventModal(
			this.app,
			calendars,
			defaultCalendarId,
			async (formData) => {
				await plugin.createNewEventNote(formData);
			},
			initialData,
		).open();
	}

	onunload(): void {
		this.calendar?.destroy();
		this.calendar = null;
		// Remove the class we added in onload so it doesn't bleed into
		// subsequent views that share the same containerEl
		this.containerEl.removeClass("cal-view-container");
	}

	onDataUpdated(): void {
		if (!this.calendar) return;

		const events = extractEvents(this);

		// Build file map for click handling
		this.fileMap.clear();
		for (const ev of events) {
			this.fileMap.set(ev.id, ev.file);
		}

		// Get cached calendar colors from plugin settings (if available)
		const pluginData = (this.app as any).plugins?.plugins?.[
			"google-calendar-sync"
		];
		const cachedCalendars = pluginData?.settings?.cachedCalendars ?? [];
		const calendarColors: Record<string, string> =
			pluginData?.settings?.calendarColors ?? {};

		const timeFormat = (this.config?.get("timeFormat") as string) ?? "12h";
		const use12h = timeFormat === "12h";

		// TUI Calendar caches template functions — if time format changed,
		// destroy and recreate the calendar to apply new templates
		if (
			this.lastTimeFormat !== null &&
			this.lastTimeFormat !== timeFormat
		) {
			const currentDate = this.calendar.getDate().toDate();
			this.calendar.destroy();
			this.calendarEl.empty();
			this.calendar = this.createCalendar(use12h);
			this.calendar.setDate(currentDate);
		}
		this.lastTimeFormat = timeFormat;

		// Build calendar infos for color mapping
		const calendarInfos = buildCalendarInfos(events, cachedCalendars, calendarColors);

		// Set per-calendar colors
		this.calendar.setCalendars(calendarInfos);

		this.calendar.clear();
		this.calendar.createEvents(toTuiEvents(events));
		this.updateTitle();
	}

	/** Navigate forward or backward. */
	private navigate(direction: 1 | -1): void {
		if (!this.calendar) return;

		const step = this.getNavStepDays();
		if (step === null) {
			// Default TUI navigation
			if (direction === 1) this.calendar.next();
			else this.calendar.prev();
		} else {
			// Custom step navigation
			this.anchorDate = addDays(this.anchorDate, direction * step);

			// For week-based views, update startDayOfWeek to the anchor's weekday
			if (this.getDefaultView() === "week") {
				this.calendar.setOptions({
					week: {
						startDayOfWeek: this.anchorDate.getDay(),
						taskView: false,
						eventView: ["allday", "time"],
					},
				});
			} else if (this.getDefaultView() === "month") {
				this.calendar.setOptions({
					month: {
						startDayOfWeek: this.anchorDate.getDay(),
						...this.getMonthOptions(),
					},
				});
			}

			this.calendar.setDate(this.anchorDate);
		}
		this.updateTitle();
	}

	/** Jump to today. */
	private goToToday(): void {
		if (!this.calendar) return;
		this.anchorDate = new Date();

		const step = this.getNavStepDays();
		if (step !== null) {
			// Reset startDayOfWeek for lookahead views
			if (this.getDefaultView() === "week") {
				this.calendar.setOptions({
					week: {
						startDayOfWeek: this.anchorDate.getDay(),
						taskView: false,
						eventView: ["allday", "time"],
					},
				});
			} else if (this.getDefaultView() === "month") {
				this.calendar.setOptions({
					month: {
						startDayOfWeek: this.anchorDate.getDay(),
						...this.getMonthOptions(),
					},
				});
			}
		}

		this.calendar.today();
		this.updateTitle();
	}

	protected updateTitle(): void {
		if (!this.calendar) return;
		const monthNames = [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		];

		const view = this.getDefaultView();
		if (view === "month") {
			const start = this.calendar.getDateRangeStart().toDate();
			const end = this.calendar.getDateRangeEnd().toDate();
			if (start.getMonth() === end.getMonth()) {
				this.titleEl.setText(
					`${monthNames[start.getMonth()]} ${start.getFullYear()}`,
				);
			} else {
				const startLabel = `${monthNames[start.getMonth()]} ${start.getDate()}`;
				const endLabel =
					start.getFullYear() === end.getFullYear()
						? `${monthNames[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`
						: `${monthNames[end.getMonth()]} ${end.getDate()}, ${end.getFullYear()}`;
				this.titleEl.setText(`${startLabel} – ${endLabel}`);
			}
		} else {
			const start = this.calendar.getDateRangeStart().toDate();
			const end = this.calendar.getDateRangeEnd().toDate();

			// For N-day views, clamp the displayed end date to anchorDate + step - 1
			const step = this.getNavStepDays();
			const displayEnd =
				step !== null && step < 7
					? addDays(this.anchorDate, step - 1)
					: end;

			const startLabel = `${monthNames[start.getMonth()]} ${start.getDate()}`;
			const endLabel =
				start.getMonth() === displayEnd.getMonth()
					? `${displayEnd.getDate()}, ${displayEnd.getFullYear()}`
					: `${monthNames[displayEnd.getMonth()]} ${displayEnd.getDate()}, ${displayEnd.getFullYear()}`;
			this.titleEl.setText(`${startLabel} – ${endLabel}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Concrete view classes
// ---------------------------------------------------------------------------

/** Standard month calendar (Sun–Sat). */
export class MonthCalendarView extends BaseTuiCalendarView {
	type = "cal-month";
	getDefaultView() {
		return "month" as const;
	}
}

/** Standard 7-day week (Sun–Sat). */
export class WeekCalendarView extends BaseTuiCalendarView {
	type = "cal-week";
	getDefaultView() {
		return "week" as const;
	}
}

/** 7-day lookahead starting from today. */
export class SevenDayCalendarView extends BaseTuiCalendarView {
	type = "cal-7day";
	getDefaultView() {
		return "week" as const;
	}
	getWeekStartDay() {
		return new Date().getDay();
	}
	getNavStepDays() {
		return 7;
	}
}

/** 14-day lookahead starting from today (month grid, 2 visible rows). */
export class FourteenDayCalendarView extends BaseTuiCalendarView {
	type = "cal-14day";
	getDefaultView() {
		return "month" as const;
	}
	getWeekStartDay() {
		return new Date().getDay();
	}
	getMonthOptions() {
		return { visibleWeeksCount: 2 };
	}
	getNavStepDays() {
		return 14;
	}
}

/** 2-week calendar (Sun–Sat × 2 rows). */
export class TwoWeekCalendarView extends BaseTuiCalendarView {
	type = "cal-2week";
	getDefaultView() {
		return "month" as const;
	}
	getMonthOptions() {
		return { visibleWeeksCount: 2 };
	}
	getNavStepDays() {
		return 14;
	}
}

// ---------------------------------------------------------------------------
// Shared options factory
// ---------------------------------------------------------------------------

export { getViewOptions };
