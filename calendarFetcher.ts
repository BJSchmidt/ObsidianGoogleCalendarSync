import { calendar_v3 } from "googleapis";
import { CalendarEventNote, GoogleCalendarListEntry } from "./types";

export class CalendarFetcher {
	constructor(private calendar: calendar_v3.Calendar) {}

	async listCalendars(): Promise<GoogleCalendarListEntry[]> {
		try {
			const response = await this.calendar.calendarList.list();
			const items = response.data.items || [];
			return items
				.filter(item => item.id && item.summary)
				.map(item => ({
					id: item.id!,
					name: item.summary!,
					color: item.backgroundColor || '#4285F4',
					isPrimary: item.primary === true,
					accessRole: item.accessRole || 'reader',
				}));
		} catch (error) {
			console.error('Error listing calendars:', error);
			return [];
		}
	}

	async fetchEventsForCalendar(
		calendarId: string,
		calendarName: string,
		timeMin: Date,
		timeMax: Date,
		syncToken?: string
	): Promise<{ events: CalendarEventNote[]; nextSyncToken: string | null; resetToken: boolean }> {
		try {
			const params: calendar_v3.Params$Resource$Events$List = {
				calendarId,
				maxResults: 2500,
			};

			if (syncToken) {
				// Incremental sync: cannot use timeMin/timeMax or singleEvents with syncToken
				params.syncToken = syncToken;
			} else {
				// Full sync: expand recurring events and filter by time window
				params.timeMin = timeMin.toISOString();
				params.timeMax = timeMax.toISOString();
				params.singleEvents = true;
				params.orderBy = 'startTime';
			}

			const allEvents: calendar_v3.Schema$Event[] = [];
			let pageToken: string | undefined;

			do {
				if (pageToken) params.pageToken = pageToken;
				const response = await this.calendar.events.list(params);
				const data = response.data;
				allEvents.push(...(data.items || []));
				pageToken = data.nextPageToken || undefined;

				if (!pageToken) {
					// Last page — capture the sync token
					const nextSyncToken = data.nextSyncToken || null;
					return {
						events: allEvents
							.map(e => this.mapEvent(e, calendarId, calendarName))
							.filter((e): e is CalendarEventNote => e !== null),
						nextSyncToken,
						resetToken: false,
					};
				}
			} while (pageToken);

			return { events: [], nextSyncToken: null, resetToken: false };
		} catch (error: any) {
			// 410 Gone: syncToken is stale, need a full resync
			const status = error?.code ?? error?.status ?? error?.response?.status;
			if (status === 410) {
				return { events: [], nextSyncToken: null, resetToken: true };
			}
			console.error(`Error fetching events for calendar ${calendarId}:`, error);
			throw error;
		}
	}

	private mapEvent(
		raw: calendar_v3.Schema$Event,
		calendarId: string,
		calendarName: string
	): CalendarEventNote | null {
		// Skip events with no start information — they are malformed API responses
		if (!raw.start?.date && !raw.start?.dateTime) {
			console.error(`Skipping malformed event (no start): id=${raw.id ?? '?'}, summary=${raw.summary ?? '?'}`);
			return null;
		}

		const isAllDay = !raw.start?.dateTime;

		// Determine the canonical date string (YYYY-MM-DD)
		const dateStr = (raw.start?.date ?? raw.start?.dateTime?.slice(0, 10))!;

		// Extract times directly from the raw dateTime string (wall-clock time in the
		// event's own timezone, not converted to system local time)
		let startTimeStr: string | null = null;
		let endTimeStr: string | null = null;
		if (!isAllDay && raw.start?.dateTime) {
			startTimeStr = raw.start.dateTime.slice(11, 16); // "HH:MM"
		}
		if (!isAllDay && raw.end?.dateTime) {
			endTimeStr = raw.end.dateTime.slice(11, 16); // "HH:MM"
		}

		// Capture the event's timezone so we can round-trip datetimes correctly
		const timezone = raw.start?.timeZone
			?? raw.end?.timeZone
			?? Intl.DateTimeFormat().resolvedOptions().timeZone;

		// For multi-day all-day events, compute inclusive end date
		// Google's end date is exclusive, so subtract 1 day
		let endDateStr: string | null = null;
		if (isAllDay && raw.end?.date) {
			const endD = new Date(raw.end.date + 'T00:00:00');
			endD.setDate(endD.getDate() - 1);
			const adjusted = endD.toISOString().slice(0, 10);
			if (adjusted !== dateStr) endDateStr = adjusted;
		}

		// Extract video conference link; fall back to hangoutLink if conferenceData
		// has no video entry (e.g. only phone/SIP entry points are present)
		const videoEntry = raw.conferenceData?.entryPoints?.find(
			e => e.entryPointType === 'video'
		);
		const videoLink = videoEntry?.uri || raw.hangoutLink || '';

		// Determine recurrence master ID
		const eventId = raw.id || '';
		let recurrenceMasterId: string | null = null;
		if (raw.recurringEventId) {
			recurrenceMasterId = raw.recurringEventId;
		} else {
			// Heuristic: IDs like "abc123_20250115T090000Z" are recurring instances
			const underscoreIdx = eventId.lastIndexOf('_');
			if (underscoreIdx > 0 && /\d{8}T\d{6}Z$/.test(eventId.slice(underscoreIdx + 1))) {
				recurrenceMasterId = eventId.slice(0, underscoreIdx);
			}
		}

		const attendees = (raw.attendees || [])
			.map(a => a.email ?? '')
			.filter(Boolean);

		const status: 'confirmed' | 'tentative' | 'cancelled' =
			raw.status === 'tentative' ? 'tentative'
			: raw.status === 'cancelled' ? 'cancelled'
			: 'confirmed';

		return {
			eventId,
			calendarId,
			calendarName,
			recurrenceMasterId,
			title: raw.summary || '(No title)',
			date: dateStr,
			startTime: startTimeStr,
			endTime: endTimeStr,
			allDay: isAllDay,
			endDate: endDateStr,
			location: raw.location || '',
			description: raw.description || '',
			attendees,
			organizer: raw.organizer?.email || '',
			status,
			videoLink,
			eventLink: raw.htmlLink || '',
			isRecurring: !!(raw.recurringEventId || raw.recurrence?.length),
			timezone,
			created: raw.created || new Date().toISOString(),
			updated: raw.updated || new Date().toISOString(),
		};
	}
}
