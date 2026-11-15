/**
 * Pure module: building rga's command line and reading its `--json` output.
 * No Obsidian or Node imports, so it is tested directly under node:test.
 */

/** One matching line, as the search box shows it. */
export interface Hit {
	/** Vault-relative path, with "/" separators. */
	path: string;
	/** 1-based PDF page, when the adapter labels pages (poppler does: "Page 12: ..."). */
	page: number | null;
	/** The line's text, without the "Page N: " label and trailing newline. */
	text: string;
	/** Matched ranges in `text`, as JavaScript string offsets [start, end). */
	ranges: Array<[number, number]>;
}

export interface SearchOptions {
	query: string;
	/** Treat the query as a regular expression instead of literal text. */
	regex: boolean;
	/** Vault-relative folders to search; empty searches the whole vault. */
	folders: string[];
	/** Glob filters passed to ripgrep (-g), e.g. "*.pdf". Empty searches every file. */
	globs: string[];
	/** Most matching lines to report per file. */
	maxPerFile: number;
}

/** The arguments for a search, run with the vault folder as the working directory. */
export function searchArgs(o: SearchOptions): string[] {
	const args = ["--json", "--smart-case", "--max-count", String(Math.max(1, Math.floor(o.maxPerFile)))];
	if (!o.regex) args.push("--fixed-strings");
	for (const g of o.globs) if (g.trim()) args.push("--glob", g.trim());
	args.push("--regexp", o.query, "--");
	args.push(...searchRoots(o.folders));
	return args;
}

/**
 * The arguments that extract and cache every matching file without printing anything:
 * a search for a pattern no file contains still runs every file through its adapter.
 */
export function warmArgs(folders: string[], globs: string[]): string[] {
	const args = ["--files-with-matches", "--fixed-strings"];
	for (const g of globs) if (g.trim()) args.push("--glob", g.trim());
	args.push("--regexp", "rga-search-warm-cache-q7v3x9-no-match", "--");
	args.push(...searchRoots(folders));
	return args;
}

function searchRoots(folders: string[]): string[] {
	const roots = folders.map(cleanFolder).filter((f) => f.length > 0);
	return roots.length ? roots : ["."];
}

/** "/archive/zotero/" -> "archive/zotero"; "/" and "" mean the whole vault. */
export function cleanFolder(folder: string): string {
	return folder.trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

/** ripgrep reports text as UTF-8 "text", or base64 "bytes" when it isn't valid UTF-8. */
interface RgData {
	text?: string;
	bytes?: string;
}

function dataBytes(d: RgData | undefined): Uint8Array | null {
	if (!d) return null;
	if (typeof d.text === "string") return new TextEncoder().encode(d.text);
	if (typeof d.bytes === "string") return Uint8Array.from(atob(d.bytes), (c) => c.charCodeAt(0));
	return null;
}

const decoder = new TextDecoder("utf-8");
const PAGE_LABEL = /^Page (\d+): /;

/**
 * Read one line of `rga --json` output. Returns a Hit for "match" lines and null for
 * everything else (begin, end, context, summary, blank or malformed lines).
 */
export function parseLine(line: string): Hit | null {
	if (!line.trim()) return null;
	let msg: unknown;
	try {
		msg = JSON.parse(line);
	} catch {
		return null;
	}
	if (!msg || typeof msg !== "object") return null;
	const m = msg as { type?: string; data?: { path?: RgData; lines?: RgData; submatches?: Array<{ start: number; end: number }> } };
	if (m.type !== "match" || !m.data) return null;

	const pathBytes = dataBytes(m.data.path);
	const lineBytes = dataBytes(m.data.lines);
	if (!pathBytes || !lineBytes) return null;

	// Submatch offsets count UTF-8 bytes in the line; convert each to a string offset.
	const ranges: Array<[number, number]> = [];
	for (const s of m.data.submatches ?? []) {
		if (typeof s.start !== "number" || typeof s.end !== "number" || s.end < s.start) continue;
		const start = decoder.decode(lineBytes.subarray(0, s.start)).length;
		const end = start + decoder.decode(lineBytes.subarray(s.start, s.end)).length;
		ranges.push([start, end]);
	}

	let text = decoder.decode(lineBytes).replace(/\r?\n$/, "");
	let page: number | null = null;
	const label = PAGE_LABEL.exec(text);
	if (label) {
		page = Number(label[1]);
		const cut = label[0].length;
		text = text.slice(cut);
		for (const r of ranges) {
			r[0] = Math.max(0, r[0] - cut);
			r[1] = Math.max(0, r[1] - cut);
		}
	}
	const clipped = ranges.filter(([a, b]) => b > a).map(([a, b]): [number, number] => [a, Math.min(b, text.length)]);

	return { path: vaultPath(decoder.decode(pathBytes)), page, text, ranges: clipped };
}

/** "./a/b.pdf" or "a\\b.pdf" -> "a/b.pdf". */
export function vaultPath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** Splits a stream of chunks into lines, holding back a partial last line. */
export class LineSplitter {
	private rest = "";
	push(chunk: string): string[] {
		const parts = (this.rest + chunk).split("\n");
		this.rest = parts.pop() ?? "";
		return parts;
	}
	flush(): string[] {
		const last = this.rest;
		this.rest = "";
		return last ? [last] : [];
	}
}

/**
 * A short excerpt of `text` around its first match, with the ranges moved to match.
 * Lines from pdftotext are usually short; this keeps long ones readable in one row.
 */
export function excerpt(text: string, ranges: Array<[number, number]>, width = 160): { text: string; ranges: Array<[number, number]> } {
	const t = text.replace(/\s+$/, "");
	if (t.length <= width) return { text: t, ranges: ranges.filter(([a]) => a < t.length) };
	const first = ranges[0]?.[0] ?? 0;
	let start = Math.max(0, first - Math.floor(width / 3));
	const end = Math.min(t.length, start + width);
	start = Math.max(0, end - width);
	const pre = start > 0 ? "…" : "";
	const post = end < t.length ? "…" : "";
	const shift = pre.length - start;
	const moved = ranges
		.filter(([a, b]) => b > start && a < end)
		.map(([a, b]): [number, number] => [Math.max(a, start) + shift, Math.min(b, end) + shift]);
	return { text: pre + t.slice(start, end) + post, ranges: moved };
}

/**
 * The PATH to run rga with. Obsidian started from the Dock or Finder inherits a minimal
 * PATH without Homebrew, but rga needs `rg`, `pdftotext` and its own `rga-preproc` on it.
 * Adds rga's own folder and the usual install locations, keeping the existing order first.
 */
export function searchPath(current: string, opts: { platform: string; home: string; rgaDir?: string }): string {
	const win = opts.platform === "win32";
	const sep = win ? ";" : ":";
	const extra = win
		? [opts.rgaDir, `${opts.home}\\scoop\\shims`, `${opts.home}\\.cargo\\bin`]
		: [opts.rgaDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", `${opts.home}/.cargo/bin`, `${opts.home}/.local/bin`, "/home/linuxbrew/.linuxbrew/bin", "/snap/bin"];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const d of [...current.split(sep), ...extra]) {
		if (!d || seen.has(d)) continue;
		seen.add(d);
		out.push(d);
	}
	return out.join(sep);
}

/** The executable name to look for on PATH. */
export function rgaExecutable(platform: string): string {
	return platform === "win32" ? "rga.exe" : "rga";
}

/** Comma- or newline-separated list -> trimmed, non-empty entries. */
export function splitList(s: string): string[] {
	return s
		.split(/[,\n]/)
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
}

/** The link that opens a hit: "a/b.pdf#page=12" for a PDF page, else the file. */
export function documentLink(hit: Pick<Hit, "path" | "page">): string {
	return hit.page !== null && /\.pdf$/i.test(hit.path) ? `${hit.path}#page=${hit.page}` : hit.path;
}

/**
 * Keeps each document's hits together, documents in order of first appearance.
 * rga searches files in parallel, so lines from different files can interleave.
 */
export function groupByDocument<T extends Pick<Hit, "path">>(hits: T[]): T[] {
	const groups = new Map<string, T[]>();
	for (const h of hits) {
		const g = groups.get(h.path);
		if (g) g.push(h);
		else groups.set(h.path, [h]);
	}
	return [...groups.values()].flat();
}
