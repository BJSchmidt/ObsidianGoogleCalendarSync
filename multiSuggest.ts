import { AbstractInputSuggest, App, TFile, getAllTags } from 'obsidian';

// ---------------------------------------------------------------------------
// MultiValueInput — chip-style multi-value input with pluggable autocomplete
// ---------------------------------------------------------------------------

type SuggestFactory = (app: App, inputEl: HTMLInputElement, onSelect: (value: string) => void) => AbstractInputSuggest<string>;

export class MultiValueInput {
	private values: string[] = [];
	private containerEl: HTMLElement;
	private chipsEl: HTMLElement;
	private inputEl: HTMLInputElement;
	private suggest: AbstractInputSuggest<string>;

	constructor(
		private app: App,
		parentEl: HTMLElement,
		suggestFactory: SuggestFactory,
		private placeholder: string = '',
	) {
		this.containerEl = parentEl.createDiv({ cls: 'cal-multi-input' });
		this.chipsEl = this.containerEl.createDiv({ cls: 'cal-multi-chips' });
		this.inputEl = this.containerEl.createEl('input', {
			type: 'text',
			placeholder: this.placeholder,
			cls: 'cal-multi-text-input',
		});

		this.suggest = suggestFactory(app, this.inputEl, (value) => this.addValue(value));
	}

	addValue(value: string): void {
		const trimmed = value.trim();
		if (!trimmed || this.values.includes(trimmed)) return;
		this.values.push(trimmed);
		this.renderChips();
		this.inputEl.value = '';
		this.inputEl.focus();
	}

	removeValue(value: string): void {
		this.values = this.values.filter(v => v !== value);
		this.renderChips();
	}

	getValues(): string[] {
		return [...this.values];
	}

	private renderChips(): void {
		this.chipsEl.empty();
		for (const value of this.values) {
			const chip = this.chipsEl.createDiv({ cls: 'cal-multi-chip' });
			chip.createSpan({ text: value });
			const removeBtn = chip.createSpan({ cls: 'cal-multi-chip-remove', text: '×' });
			removeBtn.addEventListener('click', () => this.removeValue(value));
		}
	}

	destroy(): void {
		this.suggest?.close();
	}
}

// ---------------------------------------------------------------------------
// TagSuggest — autocomplete from all vault tags
// ---------------------------------------------------------------------------

export class TagSuggest extends AbstractInputSuggest<string> {
	private onSelectCallback: (value: string) => void;

	constructor(app: App, inputEl: HTMLInputElement, onSelect: (value: string) => void) {
		super(app, inputEl);
		this.onSelectCallback = onSelect;
	}

	protected getSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		const tags = new Set<string>();

		for (const file of this.app.vault.getFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const fileTags = getAllTags(cache);
			if (!fileTags) continue;
			for (const tag of fileTags) {
				// Strip leading # for display/storage
				const clean = tag.startsWith('#') ? tag.slice(1) : tag;
				if (clean.toLowerCase().includes(lowerQuery)) {
					tags.add(clean);
				}
			}
		}

		return Array.from(tags).sort();
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		this.onSelectCallback(value);
		this.setValue('');
	}
}

// ---------------------------------------------------------------------------
// PeopleSuggest — autocomplete from notes tagged #People
// ---------------------------------------------------------------------------

export class PeopleSuggest extends AbstractInputSuggest<string> {
	private onSelectCallback: (value: string) => void;

	constructor(app: App, inputEl: HTMLInputElement, onSelect: (value: string) => void) {
		super(app, inputEl);
		this.onSelectCallback = onSelect;
	}

	protected getSuggestions(query: string): string[] {
		const lowerQuery = query.toLowerCase();
		const people: string[] = [];

		for (const file of this.app.vault.getFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = getAllTags(cache);
			if (!tags) continue;

			const isPerson = tags.some(t =>
				t.toLowerCase() === '#people' || t.toLowerCase() === 'people'
			);
			if (!isPerson) continue;

			const name = file.basename;
			if (name.toLowerCase().includes(lowerQuery)) {
				people.push(name);
			}
		}

		return people.sort();
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string, _evt: MouseEvent | KeyboardEvent): void {
		// Store as wiki-link format
		this.onSelectCallback(`[[${value}]]`);
		this.setValue('');
	}
}
