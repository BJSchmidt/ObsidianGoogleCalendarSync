import { calendar_v3, google } from "googleapis";
import { OAuthServer, OAuthCredentials } from "./oauthServer";
import { Credentials } from "google-auth-library";
import { CalendarFetcher } from "./calendarFetcher";

/** Simple retry with exponential backoff for transient API errors */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err: any) {
			lastError = err;
			const status = err?.code ?? err?.status ?? err?.response?.status;
			// Only retry on transient errors (network, rate limit, server errors)
			if (status && status < 500 && status !== 429) throw err;
			if (attempt < maxRetries) {
				const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
				await new Promise(r => setTimeout(r, delay));
			}
		}
	}
	throw lastError;
}

export interface GoogleCalendarCredentials {
	clientId: string;
	clientSecret: string;
	accessToken?: string;
	refreshToken?: string;
}

export class GoogleCalendarAPI {
	private credentials: GoogleCalendarCredentials;
	private calendar: calendar_v3.Calendar;
	private oauthServer: OAuthServer;
	private onTokensUpdated?: (tokens: Credentials) => void;
	public fetcher: CalendarFetcher;

	constructor(
		credentials: GoogleCalendarCredentials,
		onTokensUpdated?: (tokens: Credentials) => void
	) {
		this.credentials = credentials;
		this.oauthServer = new OAuthServer();
		this.onTokensUpdated = onTokensUpdated;
		this.initializeAPI();
	}

	private initializeAPI() {
		const auth = new google.auth.OAuth2(
			this.credentials.clientId,
			this.credentials.clientSecret,
			"http://localhost:8080/callback"
		);

		if (this.credentials.accessToken) {
			auth.setCredentials({
				access_token: this.credentials.accessToken,
				refresh_token: this.credentials.refreshToken,
			});

			auth.on("tokens", (tokens) => {
				if (tokens.refresh_token) {
					this.credentials.refreshToken = tokens.refresh_token;
				}
				if (tokens.access_token) {
					this.credentials.accessToken = tokens.access_token;
				}
				this.onTokensUpdated?.(tokens);
			});
		}

		this.calendar = google.calendar({ version: "v3", auth });
		this.fetcher = new CalendarFetcher(this.calendar);
	}

	async createEvent(
		calendarId: string,
		event: calendar_v3.Schema$Event
	): Promise<calendar_v3.Schema$Event | null> {
		try {
			const response = await withRetry(() =>
				this.calendar.events.insert({ calendarId, requestBody: event })
			);
			return response.data;
		} catch (error) {
			console.error(`Error creating event in calendar ${calendarId}:`, error);
			return null;
		}
	}

	async updateEvent(
		calendarId: string,
		eventId: string,
		patch: calendar_v3.Schema$Event
	): Promise<calendar_v3.Schema$Event> {
		try {
			const response = await withRetry(() =>
				this.calendar.events.patch({ calendarId, eventId, requestBody: patch })
			);
			return response.data;
		} catch (error: any) {
			const msg = error?.response?.data?.error?.message ?? error?.message ?? String(error);
			console.error(`Error updating event ${eventId} in calendar ${calendarId}:`, error);
			throw new Error(msg);
		}
	}

	async getEvent(calendarId: string, eventId: string): Promise<calendar_v3.Schema$Event> {
		const response = await withRetry(() =>
			this.calendar.events.get({ calendarId, eventId })
		);
		return response.data;
	}

	async deleteEvent(calendarId: string, eventId: string): Promise<void> {
		try {
			await withRetry(() =>
				this.calendar.events.delete({ calendarId, eventId })
			);
		} catch (error: any) {
			const msg = error?.response?.data?.error?.message ?? error?.message ?? String(error);
			console.error(`Error deleting event ${eventId} in calendar ${calendarId}:`, error);
			throw new Error(msg);
		}
	}

	async cancelEvent(calendarId: string, eventId: string): Promise<void> {
		try {
			await this.calendar.events.patch({
				calendarId,
				eventId,
				requestBody: { status: 'cancelled' },
			});
		} catch (error: any) {
			const msg = error?.response?.data?.error?.message ?? error?.message ?? String(error);
			console.error(`Error cancelling event ${eventId} in calendar ${calendarId}:`, error);
			throw new Error(msg);
		}
	}

	async startOAuthFlow(): Promise<Credentials> {
		try {
			const oauthCredentials: OAuthCredentials = {
				clientId: this.credentials.clientId,
				clientSecret: this.credentials.clientSecret,
			};
			const tokens = await this.oauthServer.startOAuthFlow(oauthCredentials);
			return tokens;
		} catch (error) {
			console.error("OAuth flow error:", error);
			throw error;
		}
	}

	cleanup(): void {
		this.oauthServer.cleanup();
	}
}
