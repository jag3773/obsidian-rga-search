import { FileSystemAdapter, MarkdownView, Notice, PaneType, Plugin } from "obsidian";
import { activeUserConfig, customAdapters, openTarget, rgaConfig, SCRIPT_FILES, searchGlobs, userConfigPath } from "./adapters";
import { SearchModal } from "./modal";
import { ReferenceIndex, referenceProps } from "./references";
import { warmArgs } from "./rga";
import { desktopModules, NodeModules, RunHandle, Runner } from "./runner";
import { fileTypes, loadSettings, RgaSearchSettings, RgaSearchSettingTab } from "./settings";

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

	platform(): string {
		return desktopModules().process.platform;
	}

	/** The globs to search: the configured ones plus the extra file types turned on. */
	globs(): string[] {
		return searchGlobs(this.settings.globs, fileTypes(this.settings, this.platform()));
	}

	/** A runner for this vault, or null when the vault isn't a folder on disk. */
	runner(): Runner | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const node = desktopModules();
		const config = this.adapterConfig(node, adapter.getFullPath(this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`));
		return new Runner(node, { rgaPath: this.settings.rgaPath, cwd: adapter.getBasePath(), env: config ? { RGA_CONFIG: config } : {} });
	}

	/**
	 * rga's config with the plugin's adapters for the extra file types, or null when none is on.
	 * Writes the helper scripts the adapters run into the plugin's folder, when they've changed.
	 */
	private adapterConfig(node: NodeModules, pluginDir: string): string | null {
		const types = fileTypes(this.settings, node.process.platform);
		const dir = node.path.join(pluginDir, "adapters");
		const adapters = customAdapters(types, { keynoteSpotlight: node.path.join(dir, "keynote-spotlight.sh"), keynoteExport: node.path.join(dir, "keynote-export.sh") });
		if (!adapters.length) return null;
		if (types.keynote !== "off") {
			try {
				node.fs.mkdirSync(dir, { recursive: true });
				for (const [name, text] of Object.entries(SCRIPT_FILES)) {
					const file = node.path.join(dir, name);
					if (!node.fs.existsSync(file) || node.fs.readFileSync(file, "utf8") !== text) node.fs.writeFileSync(file, text);
				}
			} catch (e) {
				new Notice(`RGA Search couldn't write its Keynote scripts: ${(e as Error).message}`);
			}
		}
		const user = activeUserConfig(node.process.env, () => {
			try {
				return node.fs.readFileSync(userConfigPath(node.process.platform, node.os.homedir(), node.process.env), "utf8");
			} catch {
				return null;
			}
		});
		return rgaConfig(user, adapters);
	}

	/**
	 * Opens a result: its link in Obsidian, or the file at `path` (the hit's own path) in its
	 * default app when Obsidian has no view for its type.
	 */
	private openDocument(path: string, link: string, newLeaf: PaneType | boolean): void {
		// Obsidian doesn't publish which extensions it can show; core and plugin views register here.
		const registry = (this.app as unknown as { viewRegistry?: { isExtensionRegistered?(ext: string): boolean } }).viewRegistry;
		const adapter = this.app.vault.adapter;
		const target = registry?.isExtensionRegistered && adapter instanceof FileSystemAdapter ? openTarget(path, link, (ext) => registry.isExtensionRegistered?.(ext) ?? true) : { app: "obsidian" as const, link };
		if (target.app === "obsidian" || !(adapter instanceof FileSystemAdapter)) {
			void this.app.workspace.openLinkText(link, "", newLeaf);
			return;
		}
		const electron = window.require("electron") as { shell: { openPath(path: string): Promise<string> } };
		void electron.shell.openPath(adapter.getFullPath(target.path)).then((err: string) => {
			if (err) new Notice(`RGA Search couldn't open ${path}: ${err}`);
		});
	}

	openSearch(query = ""): void {
		const runner = this.runner();
		if (!runner) {
			new Notice("RGA Search needs the desktop app with the vault on a local disk.");
			return;
		}
		const s = this.settings;
		const refs = new ReferenceIndex(this.app, referenceProps(this.app, { links: s.linkProperties, titles: [s.titleProperty], citekeys: [s.citekeyProperty] }, s.useStacks)).build();
		const modal = new SearchModal(this.app, runner, s, refs, this.globs(), (path, link, newLeaf) => this.openDocument(path, link, newLeaf), query || this.selectedText());
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
		const handle = runner.run(warmArgs(this.settings.folders, this.globs()));
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
