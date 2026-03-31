import { App, TFile } from 'obsidian';
import { CalendarEventNote } from './types';

const DEFAULT_TEMPLATE = '# {{title}}\n';

export class TemplateEngine {
	constructor(private app: App) {}

	async renderBody(event: CalendarEventNote, templatePath: string): Promise<string> {
		if (templatePath) {
			const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
			if (templateFile instanceof TFile) {
				try {
					const raw = await this.app.vault.read(templateFile);
					// Strip the template file's own frontmatter — this template provides the
					// note *body* only. The event frontmatter is built by noteManager.buildFrontmatter().
					const body = this.stripFrontmatter(raw);
					return this.substitute(body, event);
				} catch (error) {
					console.error('Error reading note body template:', error);
				}
			}
		}
		return this.substitute(DEFAULT_TEMPLATE, event);
	}

	private stripFrontmatter(content: string): string {
		const lines = content.split('\n');
		if (lines[0]?.trim() !== '---') return content;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				const rest = lines.slice(i + 1).join('\n');
				return rest.replace(/^\n+/, '');
			}
		}
		return content;
	}

	async renderNewEventTemplate(templatePath: string): Promise<string> {
		if (templatePath) {
			const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
			if (templateFile instanceof TFile) {
				try {
					return await this.app.vault.read(templateFile);
				} catch (error) {
					console.error('Error reading new event template:', error);
				}
			}
		}
		return this.defaultNewEventTemplate();
	}

	private substitute(template: string, event: CalendarEventNote): string {
		const vars: Record<string, string> = {
			title: event.title,
			date: event.date,
			startTime: event.startTime ?? '',
			endTime: event.endTime ?? '',
			allDay: String(event.allDay),
			location: event.location,
			description: event.description,
			organizer: event.organizer,
			attendees: event.attendees.join(', '),
			calendarName: event.calendarName,
			videoLink: event.videoLink,
			status: event.status,
		};

		return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
			return key in vars ? vars[key] : `{{${key}}}`;
		});
	}

	private defaultNewEventTemplate(): string {
		return [
			'---',
			'cal-type: calendar-event',
			'cal-calendar: primary',
			'cal-event-id: ',
			'title: ',
			'date: ',
			'startTime: ',
			'endTime: ',
			'endDate: ',
			'cal-location: ',
			'cal-description: ',
			'cal-attendees:',
			'  - ',
			'cal-organizer: ',
			'cal-status: confirmed',
			'cal-video-link: ',
			'---',
			'',
			'# ',
			'',
		].join('\n');
	}
}
