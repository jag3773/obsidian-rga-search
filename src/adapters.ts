/**
 * Extra file types, read through rga's custom adapters. rga runs an adapter's program with the
 * file on stdin and searches what it prints, caching that text like its own adapters' output.
 * An adapter that prints a PDF (with an output path hint ending in .pdf) is passed on to rga's
 * PDF reader, so its pages are labelled like any PDF's.
 *
 * rga reads its configuration from one place only: the RGA_CONFIG environment variable, when
 * set, replaces the user's own config file. So the plugin merges the user's config with its own
 * adapters and passes the result in RGA_CONFIG.
 */

/** How Keynote decks are read. */
export type KeynoteMode = "off" | "spotlight" | "export";

export interface FileTypeOptions {
	/** PowerPoint and Excel, through pandoc. */
	office: boolean;
	keynote: KeynoteMode;
}

/** Where the plugin's helper scripts are. */
export interface ScriptPaths {
	keynoteSpotlight: string;
	keynoteExport: string;
}

interface CustomAdapter {
	name: string;
	version: number;
	description: string;
	extensions: string[];
	binary: string;
	args: string[];
	output_path_hint?: string;
}

/** The file types each option adds to the searched globs. */
export function extraGlobs(o: FileTypeOptions): string[] {
	const globs: string[] = [];
	if (o.office) globs.push("*.pptx", "*.xlsx");
	if (o.keynote !== "off") globs.push("*.key");
	return globs;
}

/** The globs to search: the configured ones plus those of the enabled types. Empty still means every file. */
export function searchGlobs(globs: string[], o: FileTypeOptions): string[] {
	const own = globs.map((g) => g.trim()).filter(Boolean);
	if (!own.length) return [];
	const lower = new Set(own.map((g) => g.toLowerCase()));
	return [...own, ...extraGlobs(o).filter((g) => !lower.has(g))];
}

/**
 * The plugin's adapters. Each way of reading a type has its own name, so rga caches each
 * separately: switching between Spotlight and Keynote's export keeps both caches.
 */
export function customAdapters(o: FileTypeOptions, scripts: ScriptPaths): CustomAdapter[] {
	const adapters: CustomAdapter[] = [];
	if (o.office)
		adapters.push({
			name: "rga_search_office",
			version: 1,
			description: "PowerPoint and Excel files, through pandoc (added by RGA Search)",
			extensions: ["pptx", "xlsx"],
			binary: "pandoc",
			// rga fills in $input_file_extension: pptx or xlsx.
			args: ["--from=$input_file_extension", "--to=plain", "--wrap=none"],
		});
	if (o.keynote === "spotlight")
		adapters.push({
			name: "rga_search_keynote_spotlight",
			version: 1,
			description: "Keynote decks, through Spotlight's text (added by RGA Search)",
			extensions: ["key"],
			binary: "/bin/sh",
			args: [scripts.keynoteSpotlight],
		});
	if (o.keynote === "export")
		adapters.push({
			name: "rga_search_keynote_export",
			version: 1,
			description: "Keynote decks, exported to PDF by Keynote (added by RGA Search)",
			extensions: ["key"],
			binary: "/bin/sh",
			args: [scripts.keynoteExport],
			output_path_hint: "${input_virtual_path}.pdf",
		});
	return adapters;
}

/** JSON with comments and trailing commas (rga's config.jsonc) as plain JSON. Strings are left as they are. */
export function stripJsonc(text: string): string {
	// Each pass copies strings whole, so a "//", ",}" or ",]" inside one is never touched.
	return dropTrailingCommas(dropComments(text));
}

/** The end of the string literal starting at text[i] (a quote): the index just past its closing quote. */
function stringEnd(text: string, i: number): number {
	let j = i + 1;
	while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
	return j + 1;
}

function dropComments(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			const end = stringEnd(text, i);
			out += text.slice(i, end);
			i = end;
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

function dropTrailingCommas(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			const end = stringEnd(text, i);
			out += text.slice(i, end);
			i = end;
			continue;
		}
		if (c === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") {
				i++;
				continue;
			}
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * The text of the config rga would use on its own: RGA_CONFIG when Obsidian inherited one
 * (rga then ignores its config file), else the config file, else null.
 */
export function activeUserConfig(env: Record<string, string | undefined>, readConfigFile: () => string | null): string | null {
	const inherited = env.RGA_CONFIG;
	if (inherited !== undefined && inherited.trim()) return inherited;
	return readConfigFile();
}

/**
 * The config to pass in RGA_CONFIG: the user's own config (the text of their config.jsonc, or
 * null when there is none) with the plugin's adapters added. Null when the plugin has no
 * adapters to add, so rga reads the user's config itself. An adapter of the user's with the same
 * name as one of the plugin's is replaced.
 */
export function rgaConfig(userText: string | null, adapters: CustomAdapter[]): string | null {
	if (!adapters.length) return null;
	let user: Record<string, unknown> = {};
	if (userText?.trim()) {
		try {
			const parsed: unknown = JSON.parse(stripJsonc(userText));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) user = parsed as Record<string, unknown>;
		} catch {
			// rga would reject this file too; the plugin's adapters still work without it.
		}
	}
	const { $schema: _schema, ...rest } = user;
	const own = new Set(adapters.map((a) => a.name));
	const theirs = Array.isArray(rest.custom_adapters) ? (rest.custom_adapters as unknown[]).filter((a) => !own.has((a as { name?: unknown })?.name as string)) : [];
	return JSON.stringify({ ...rest, custom_adapters: [...theirs, ...adapters] });
}

/** rga's own config file, which RGA_CONFIG replaces. */
export function userConfigPath(platform: string, home: string, env: Record<string, string | undefined>): string {
	if (platform === "darwin") return `${home}/Library/Application Support/ripgrep-all/config.jsonc`;
	if (platform === "win32") return `${env.APPDATA ?? `${home}\\AppData\\Roaming`}\\ripgrep-all\\config\\config.jsonc`;
	return `${env.XDG_CONFIG_HOME || `${home}/.config`}/ripgrep-all/config.jsonc`;
}

/** File types Obsidian opens itself; anything else opens in its default app. */
export function opensInObsidian(path: string, registered: (ext: string) => boolean): boolean {
	const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
	return registered(ext);
}

/**
 * How to open a result: its link in Obsidian (with a PDF's "#page=N"), or its file in the
 * default app. The file is the hit's own path, which may contain "#" as an ordinary character.
 */
export function openTarget(path: string, link: string, registered: (ext: string) => boolean): { app: "obsidian"; link: string } | { app: "default"; path: string } {
	return opensInObsidian(path, registered) ? { app: "obsidian", link } : { app: "default", path };
}

/*
 * The helper scripts. rga replaces anything that looks like `$name` in an adapter's arguments,
 * so the shell code lives in files the plugin writes, and the arguments are only their paths.
 * Both copy the deck from stdin to a temporary file, which also works for a deck inside a zip.
 */

/** Spotlight's text for a deck, via `mdimport -t -d3`: fast, but without slide numbers. */
export const KEYNOTE_SPOTLIGHT_SH = `# Written by RGA Search: prints the text Spotlight finds in a Keynote deck read from stdin.
d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$d/deck.key" || exit 1
/usr/bin/osascript -l JavaScript "$(dirname "$0")/keynote-spotlight.js" "$d/deck.key"
`;

/**
 * mdimport prints each attribute in Objective-C's description format, so the text comes back
 * as a quoted, escaped string; Foundation's property-list parser reads that format.
 */
export const KEYNOTE_SPOTLIGHT_JS = `// Written by RGA Search: prints the kMDItemTextContent Spotlight extracts from argv[0].
ObjC.import("Foundation");
function run(argv) {
	const app = Application.currentApplication();
	app.includeStandardAdditions = true;
	const quoted = "'" + argv[0].replace(/'/g, "'\\\\''") + "'";
	const out = app.doShellScript("/usr/bin/mdimport -t -d3 " + quoted + " 2>&1");
	const m = out.match(/kMDItemTextContent = ("(?:[^"\\\\]|\\\\.)*")/);
	if (!m) return "";
	return ObjC.unwrap($.NSString.alloc.initWithString(m[1]).propertyList);
}
`;

/**
 * Keynote's own PDF export: slower, and it starts Keynote, but each slide becomes a page.
 * Keynote handles one export at a time, so concurrent extractions wait on a lock.
 */
export const KEYNOTE_EXPORT_SH = `# Written by RGA Search: exports a Keynote deck read from stdin to PDF with Keynote, and prints the PDF.
d=$(mktemp -d) || exit 1
lock="\${TMPDIR:-/tmp}/rga-search-keynote.lock"
locked=
cleanup() { rm -rf "$d"; if [ -n "$locked" ]; then rmdir "$lock" 2>/dev/null; fi; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
cat > "$d/deck.key" || exit 1
# A lock left by an export that was killed outright is cleared after 15 minutes.
find "$lock" -maxdepth 0 -mmin +15 -exec rmdir {} \\; 2>/dev/null
until mkdir "$lock" 2>/dev/null; do sleep 0.5; done
locked=1
/usr/bin/osascript -l JavaScript "$(dirname "$0")/keynote-export.js" "$d/deck.key" "$d/deck.pdf" >&2 || exit 1
cat "$d/deck.pdf"
`;

export const KEYNOTE_EXPORT_JS = `// Written by RGA Search: exports the Keynote deck argv[0] to the PDF argv[1].
function run(argv) {
	const keynote = Application("com.apple.Keynote");
	const wasRunning = keynote.running();
	const doc = keynote.open(Path(argv[0]));
	try {
		keynote.export(doc, { to: Path(argv[1]), as: "PDF" });
	} finally {
		doc.close({ saving: "no" });
		// Leave Keynote as it was: quit it only if this started it and nothing else is open.
		if (!wasRunning && keynote.documents.length === 0) keynote.quit();
	}
}
`;

/** The script files to write into the plugin's folder, by name. */
export const SCRIPT_FILES: Record<string, string> = {
	"keynote-spotlight.sh": KEYNOTE_SPOTLIGHT_SH,
	"keynote-spotlight.js": KEYNOTE_SPOTLIGHT_JS,
	"keynote-export.sh": KEYNOTE_EXPORT_SH,
	"keynote-export.js": KEYNOTE_EXPORT_JS,
};
