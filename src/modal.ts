import { App, Keymap, Notice, Platform, SuggestModal } from "obsidian";
import { documentLink, excerpt, groupByDocument, Hit, searchArgs } from "./rga";
import type { ReferenceIndex } from "./references";
import type { RunHandle, Runner } from "./runner";
import type { RgaSearchSettings } from "./settings";

const DEBOUNCE_MS = 200;

type Row = Hit & { ref: ReturnType<ReferenceIndex["get"]> };

/** The search box: type, see matching lines grouped by document, open one at its page. */
export class SearchModal extends SuggestModal<Row> {
	private seq = 0;
	private current: RunHandle | null = null;
	private last: Row[] = [];
	private warned = new Set<string>();

	constructor(
		app: App,
		private runner: Runner,
		private settings: RgaSearchSettings,
		private refs: ReferenceIndex,
		initialQuery = "",
	) {
		super(app);
		this.limit = settings.maxResults;
		this.setPlaceholder("Search inside PDFs and other documents…");
		this.emptyStateText = `Type at least ${settings.minChars} characters.`;
		this.setInstructions([
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to open at the page" },
			{ command: Platform.isMacOS ? "⌘ ↵" : "ctrl ↵", purpose: "to open in a new tab" },
			{ command: "shift ↵", purpose: "to open the reference note" },
			{ command: "esc", purpose: "to dismiss" },
		]);
		// Shift+Enter and Mod+Enter choose the selected row too; onChooseSuggestion reads the keys.
		for (const mods of [["Shift"], ["Mod"]] as const) {
			this.scope.register([...mods], "Enter", (evt) => {
				(this as unknown as { chooser?: { useSelectedItem(e: KeyboardEvent): boolean } }).chooser?.useSelectedItem(evt);
				return false;
			});
		}
		if (initialQuery) this.inputEl.value = initialQuery;
	}

	onClose(): void {
		this.seq++;
		this.current?.cancel();
		super.onClose();
	}

	async getSuggestions(query: string): Promise<Row[]> {
		const q = query.trim();
		const token = ++this.seq;
		this.current?.cancel();
		this.current = null;
		if (q.length < this.settings.minChars) {
			this.emptyStateText = `Type at least ${this.settings.minChars} characters.`;
			return (this.last = []);
		}
		await new Promise((r) => window.setTimeout(r, DEBOUNCE_MS));
		if (token !== this.seq) return this.last;

		this.emptyStateText = "Searching…";
		const handle = this.runner.run(
			searchArgs({ query: q, regex: this.settings.regex, folders: this.settings.folders, globs: this.settings.globs, maxPerFile: this.settings.maxPerFile }),
			this.settings.maxResults,
		);
		this.current = handle;
		const out = await handle.done;
		if (token !== this.seq || out.cancelled) return this.last;
		this.current = null;
		this.emptyStateText = out.error ?? (out.warning ? `No matches. ${out.warning}` : "No matches.");
		// Files that can't be read fail on every search, so say so once per search box.
		if (out.warning && out.hits.length && !this.warned.has(out.warning)) {
			this.warned.add(out.warning);
			new Notice(`RGA Search: ${out.warning}`, 8000);
		}
		const rows = groupByDocument(out.hits).map((h) => ({ ...h, ref: this.refs.get(h.path) }));
		return (this.last = rows);
	}

	renderSuggestion(row: Row, el: HTMLElement): void {
		el.addClass("rga-search-result");
		const head = el.createDiv({ cls: "rga-search-head" });
		head.createSpan({ cls: "rga-search-title", text: row.ref?.title ?? fileName(row.path) });
		if (row.page !== null) head.createSpan({ cls: "rga-search-page", text: `p. ${row.page}` });

		const snippet = el.createDiv({ cls: "rga-search-snippet" });
		const ex = excerpt(row.text, row.ranges);
		let at = 0;
		for (const [a, b] of ex.ranges) {
			if (a < at) continue;
			snippet.appendText(ex.text.slice(at, a));
			snippet.createSpan({ cls: "rga-search-match", text: ex.text.slice(a, b) });
			at = b;
		}
		snippet.appendText(ex.text.slice(at));

		const meta = el.createDiv({ cls: "rga-search-meta" });
		if (row.ref?.citekey) meta.createSpan({ cls: "rga-search-citekey", text: `@${row.ref.citekey}` });
		meta.createSpan({ cls: "rga-search-path", text: row.path });
	}

	onChooseSuggestion(row: Row, evt: MouseEvent | KeyboardEvent): void {
		if (evt.shiftKey && row.ref) {
			void this.app.workspace.openLinkText(row.ref.path, "", Keymap.isModEvent(evt));
			return;
		}
		void this.app.workspace.openLinkText(documentLink(row), "", Keymap.isModEvent(evt));
	}
}

function fileName(path: string): string {
	return path.split("/").pop() ?? path;
}
