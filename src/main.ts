import { FileSystemAdapter, MarkdownView, Notice, Plugin } from "obsidian";
import { SearchModal } from "./modal";
import { ReferenceIndex, referenceProps } from "./references";
import { warmArgs } from "./rga";
import { desktopModules, RunHandle, Runner } from "./runner";
import { loadSettings, RgaSearchSettings, RgaSearchSettingTab } from "./settings";

const STARTUP_WARM_DELAY_MS = 30 * 1000;

export default class RgaSearchPlugin extends Plugin {
	settings!: RgaSearchSettings;
	/** The running cache warm-up, stopped when the plugin unloads. */
	private warming: RunHandle | null = null;

	async onload(): Promise<void> {
		this.settings = loadSettings(await this.loadData());
		this.addSettingTab(new RgaSearchSettingTab(this.app, this));

		this.addRibbonIcon("file-search", "Search inside documents", () => this.openSearch());
		this.addCommand({ id: "search", name: "Search inside documents", callback: () => this.openSearch() });
		this.addCommand({
			id: "search-selection",
			name: "Search inside documents for the selection",
			editorCallback: (editor) => this.openSearch(editor.getSelection().trim()),
		});
		this.addCommand({ id: "warm-cache", name: "Warm the cache", callback: () => void this.warmCache() });

		this.app.workspace.onLayoutReady(() => {
			if (!this.settings.warmOnStartup) return;
			const timer = window.setTimeout(() => void this.warmCache(true), STARTUP_WARM_DELAY_MS);
			this.register(() => window.clearTimeout(timer));
		});
		// A warm-up still running when the plugin is disabled or reloaded is stopped with all
		// its processes. Files already extracted stay cached, so the next warm-up skips them.
		this.register(() => {
			this.warming?.cancel();
			this.warming = null;
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** A runner for this vault, or null when the vault isn't a folder on disk. */
	runner(): Runner | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return new Runner(desktopModules(), { rgaPath: this.settings.rgaPath, cwd: adapter.getBasePath() });
	}

	openSearch(query = ""): void {
		const runner = this.runner();
		if (!runner) {
			new Notice("RGA Search needs the desktop app with the vault on a local disk.");
			return;
		}
		const s = this.settings;
		const refs = new ReferenceIndex(this.app, referenceProps(this.app, { links: s.linkProperties, titles: [s.titleProperty], citekeys: [s.citekeyProperty] }, s.useStacks)).build();
		const modal = new SearchModal(this.app, runner, s, refs, query || this.selectedText());
		modal.open();
	}

	private selectedText(): string {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sel = view?.editor.getSelection().trim() ?? "";
		return sel.includes("\n") ? "" : sel;
	}

	/** Run every searched document through rga once so later searches read its cache. */
	async warmCache(quiet = false): Promise<void> {
		if (this.warming) {
			if (!quiet) new Notice("RGA Search is already warming the cache.");
			return;
		}
		const runner = this.runner();
		if (!runner) {
			if (!quiet) new Notice("RGA Search needs the desktop app with the vault on a local disk.");
			return;
		}
		const handle = runner.run(warmArgs(this.settings.folders, this.settings.globs));
		this.warming = handle;
		const notice = quiet ? null : new Notice("RGA Search: extracting document text. The first pass over a large library can take a while.", 0);
		const started = Date.now();
		try {
			const out = await handle.done;
			if (out.cancelled) return;
			const mins = Math.round((Date.now() - started) / 60000);
			const took = mins >= 1 ? `${mins} min` : `${Math.round((Date.now() - started) / 1000)}s`;
			if (out.error) new Notice(`RGA Search: ${out.error}`);
			else if (!quiet) new Notice(`RGA Search: the cache is warm (${took}).${out.warning ? ` ${out.warning}` : ""}`, out.warning ? 15000 : 5000);
		} finally {
			notice?.hide();
			if (this.warming === handle) this.warming = null;
		}
	}
}
