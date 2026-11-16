import { App, PluginSettingTab, Setting } from "obsidian";
import type RgaSearchPlugin from "./main";
import { splitList } from "./rga";

export interface RgaSearchSettings {
	/** Path to rga; empty finds it on PATH (plus the usual Homebrew and Cargo folders). */
	rgaPath: string;
	/** Vault-relative folders to search; empty searches the whole vault. */
	folders: string[];
	/** File globs to search. */
	globs: string[];
	/** Treat queries as regular expressions. */
	regex: boolean;
	/** Characters to type before a search starts. */
	minChars: number;
	maxResults: number;
	maxPerFile: number;
	/** Extract new documents into rga's cache a little after Obsidian starts. */
	warmOnStartup: boolean;
	/** Properties that link a note to its document. */
	linkProperties: string[];
	titleProperty: string;
	citekeyProperty: string;
	/** Use Stacks' own property names when Stacks is installed. */
	useStacks: boolean;
}

export const DEFAULT_SETTINGS: RgaSearchSettings = {
	rgaPath: "",
	folders: [],
	globs: ["*.pdf", "*.epub"],
	regex: false,
	minChars: 3,
	maxResults: 200,
	maxPerFile: 5,
	warmOnStartup: false,
	linkProperties: ["pdf", "attachments"],
	titleProperty: "title",
	citekeyProperty: "citekey",
	useStacks: true,
};

/** Saved data merged over the defaults, with each field checked. */
export function loadSettings(saved: unknown): RgaSearchSettings {
	const s = { ...DEFAULT_SETTINGS };
	if (!saved || typeof saved !== "object") return s;
	const o = saved as Record<string, unknown>;
	const str = (k: keyof RgaSearchSettings) => (typeof o[k] === "string" ? (o[k]) : undefined);
	const list = (k: keyof RgaSearchSettings) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === "string") : undefined);
	const num = (k: keyof RgaSearchSettings, min: number) => (typeof o[k] === "number" && Number.isFinite(o[k]) && (o[k]) >= min ? Math.floor(o[k]) : undefined);
	const bool = (k: keyof RgaSearchSettings) => (typeof o[k] === "boolean" ? (o[k]) : undefined);
	s.rgaPath = str("rgaPath") ?? s.rgaPath;
	s.folders = list("folders") ?? s.folders;
	s.globs = list("globs") ?? s.globs;
	s.regex = bool("regex") ?? s.regex;
	s.minChars = num("minChars", 1) ?? s.minChars;
	s.maxResults = num("maxResults", 1) ?? s.maxResults;
	s.maxPerFile = num("maxPerFile", 1) ?? s.maxPerFile;
	s.warmOnStartup = bool("warmOnStartup") ?? s.warmOnStartup;
	s.linkProperties = list("linkProperties") ?? s.linkProperties;
	s.titleProperty = str("titleProperty") ?? s.titleProperty;
	s.citekeyProperty = str("citekeyProperty") ?? s.citekeyProperty;
	s.useStacks = bool("useStacks") ?? s.useStacks;
	return s;
}

export class RgaSearchSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: RgaSearchPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		const status = new Setting(containerEl).setName("Status").setDesc("Checking for ripgrep-all…");
		status.addButton((b) => b.setButtonText("Check again").onClick(() => void this.check(status)));
		void this.check(status);

		new Setting(containerEl)
			.setName("Path to rga")
			.setDesc("Leave empty to find rga on your path and in the usual Homebrew and Cargo folders.")
			.addText((t) =>
				t
					.setPlaceholder("/opt/homebrew/bin/rga")
					.setValue(s.rgaPath)
					.onChange((v) => {
						s.rgaPath = v.trim();
						save();
					}),
			);

		new Setting(containerEl).setName("Search").setHeading();

		new Setting(containerEl)
			.setName("Folders")
			.setDesc("Vault folders to search, separated by commas. Leave empty to search the whole vault.")
			.addTextArea((t) =>
				t
					.setPlaceholder("Archive/zotero")
					.setValue(s.folders.join(", "))
					.onChange((v) => {
						s.folders = splitList(v);
						save();
					}),
			);

		new Setting(containerEl)
			.setName("File types")
			.setDesc("Glob patterns, separated by commas. Notes are left to Obsidian's own search. Other types rga reads include *.docx, *.odt and *.zip.")
			.addText((t) =>
				t.setValue(s.globs.join(", ")).onChange((v) => {
					s.globs = splitList(v);
					save();
				}),
			);

		new Setting(containerEl)
			.setName("Regular expressions")
			.setDesc("Off: the query is plain text, and a phrase is found even where it breaks across lines. On: it is a ripgrep regular expression, matched one line at a time. Lowercase queries ignore case either way.")
			.addToggle((t) =>
				t.setValue(s.regex).onChange((v) => {
					s.regex = v;
					save();
				}),
			);

		this.number("Minimum query length", "Characters to type before searching.", () => s.minChars, (v) => (s.minChars = v));
		this.number("Maximum results", "The search stops after this many matching lines.", () => s.maxResults, (v) => (s.maxResults = v));
		this.number("Matches per file", "Most matching lines shown from one file.", () => s.maxPerFile, (v) => (s.maxPerFile = v));

		new Setting(containerEl).setName("Cache").setHeading();

		new Setting(containerEl)
			.setName("Warm the cache at startup")
			.setDesc("Extract the text of new documents in the background shortly after Obsidian starts, so the first search is fast. The cache lives outside the vault, in rga's own cache folder.")
			.addToggle((t) =>
				t.setValue(s.warmOnStartup).onChange((v) => {
					s.warmOnStartup = v;
					save();
				}),
			)
			.addButton((b) => b.setButtonText("Warm now").onClick(() => void this.plugin.warmCache()));

		new Setting(containerEl).setName("Reference notes").setHeading();

		new Setting(containerEl)
			.setName("Use Stacks' properties")
			.setDesc("When the Stacks plugin is installed, use its property names for the document link, title and citekey.")
			.addToggle((t) =>
				t.setValue(s.useStacks).onChange((v) => {
					s.useStacks = v;
					save();
				}),
			);

		this.text("Link properties", "Properties that link a note to its document, separated by commas.", () => s.linkProperties.join(", "), (v) => (s.linkProperties = splitList(v)));
		this.text("Title property", "Shown as the result's title.", () => s.titleProperty, (v) => (s.titleProperty = v.trim()));
		this.text("Citekey property", "Shown beside the result.", () => s.citekeyProperty, (v) => (s.citekeyProperty = v.trim()));
	}

	private async check(status: Setting): Promise<void> {
		const runner = this.plugin.runner();
		if (!runner) {
			status.setDesc("RGA Search needs the desktop app with the vault on a local disk.");
			return;
		}
		const v = await runner.version();
		const parts = [v.text];
		if (v.ok && !runner.hasProgram("pdftotext")) parts.push("pdftotext (poppler) was not found, so PDFs can't be read. Install poppler, for example with `brew install poppler`.");
		status.setDesc(parts.join(" "));
	}

	private text(name: string, desc: string, get: () => string, set: (v: string) => void): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((t) =>
				t.setValue(get()).onChange((v) => {
					set(v);
					void this.plugin.saveSettings();
				}),
			);
	}

	private number(name: string, desc: string, get: () => number, set: (v: number) => void): void {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((t) => {
				t.inputEl.type = "number";
				t.inputEl.min = "1";
				t.setValue(String(get())).onChange((v) => {
					const n = Math.floor(Number(v));
					if (Number.isFinite(n) && n >= 1) {
						set(n);
						void this.plugin.saveSettings();
					}
				});
			});
	}
}
