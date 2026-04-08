export interface GoogleCalendarSyncSettings {
	googleClientId: string;
	googleClientSecret: string;
	googleAccessToken: string;
	googleRefreshToken: string;
	syncFolder: string;
	enabledCalendars: string[];
	syncDaysBack: number;
	syncDaysForward: number;
	autoSyncInterval: number;
	lastSyncTime: string;
	syncTokens: Record<string, string>;
	templatePath: string;
	newEventTemplatePath: string;
	defaultCalendarId: string;
	deleteNotesForRemovedEvents: boolean;
	calendarColors: Record<string, string>;
	timeFormat: '12h' | '24h';
	calendarCustomProperties: Record<string, string>;
	googleUserEmail: string;
	onNoteDeleteBehavior: 'ignore' | 'cancel' | 'delete';
	showPushNotifications: boolean;
	cachedCalendars: GoogleCalendarListEntry[];
}

export const DEFAULT_SETTINGS: GoogleCalendarSyncSettings = {
	googleClientId: '',
	googleClientSecret: '',
	googleAccessToken: '',
	googleRefreshToken: '',
	syncFolder: 'Calendar',
	enabledCalendars: [],
	syncDaysBack: 30,
	syncDaysForward: 30,
	autoSyncInterval: 15,
	lastSyncTime: '',
	syncTokens: {},
	templatePath: '',
	newEventTemplatePath: '',
	defaultCalendarId: 'primary',
	deleteNotesForRemovedEvents: false,
	calendarColors: {},
	timeFormat: '12h',
	calendarCustomProperties: {},
	googleUserEmail: '',
	onNoteDeleteBehavior: 'ignore',
	showPushNotifications: true,
	cachedCalendars: [],
};

export interface CalendarEventNote {
	eventId: string;
	calendarId: string;
	calendarName: string;
	recurrenceMasterId: string | null;
	title: string;
	date: string;
	startTime: string | null;
	endTime: string | null;
	allDay: boolean;
	endDate: string | null;
	location: string;
	description: string;
	attendees: string[];
	organizer: string;
	status: 'confirmed' | 'tentative' | 'cancelled';
	videoLink: string;
	eventLink: string;
	isRecurring: boolean;
	timezone: string;
	created: string;
	updated: string;
}

export interface FrontmatterSnapshot {
	title: string;
	date: string;
	startTime: string | null;
	endTime: string | null;
	allDay: boolean;
	endDate: string | null;
	location: string;
	description: string;
	updated: string;
}

export interface GoogleCalendarListEntry {
	id: string;
	name: string;
	color: string;
	isPrimary: boolean;
	accessRole: string;
}

export interface NewEventFormData {
	title: string;
	date: string;        // YYYY-MM-DD
	startTime: string;   // HH:MM or empty
	endTime: string;     // HH:MM or empty
	endDate: string;     // YYYY-MM-DD or empty (for multi-day timed events)
	allDay: boolean;
	calendarId: string;
	calendarName: string;
	location: string;
	description: string;
	tags: string[];      // e.g. ['meeting', 'project-x']
	people: string[];    // e.g. ['[[John Doe]]', '[[Jane Smith]]']
}

export interface SyncResult {
	created: number;
	updated: number;
	deleted: number;
	skipped: number;
	errors: string[];
}
