import type { App, TFile } from "obsidian";

/** The reference note that links to a document, as a result row shows it. */
export interface Reference {
	/** The note's path. */
	path: string;
	/** Its title property, else its file name. */
	title: string;
	citekey: string | null;
}

/** Which frontmatter properties to read. Each list is tried in order. */
export interface ReferenceProps {
	/** Properties that link to the document, e.g. ["pdf", "attachments"]. */
	links: string[];
	titles: string[];
	citekeys: string[];
}

/**
 * The link targets in a property value: wikilinks ("[[a.pdf]]", "[[a.pdf#page=3|A]]"),
 * Markdown links ("[A](a%20b.pdf)") or a bare path, alone or in a list.
 * Subpaths and aliases are dropped.
 */
export function linkTargets(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap(linkTargets);
	if (typeof value !== "string") return [];
	const v = value.trim();
	if (!v) return [];
	const out: string[] = [];
	for (const m of v.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.push(m[1].trim());
	for (const dest of markdownLinkDestinations(v)) out.push(decodeLink(dest.replace(/#.*$/, "").trim()));
	if (out.length) return out.filter(Boolean);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return [];
	return [v.replace(/#.*$/, "").trim()].filter(Boolean);
}

/**
 * Destinations of Markdown links, following CommonMark: "<...>" may hold spaces and
 * parentheses; otherwise parentheses must balance, and the destination ends at the first
 * space, before an optional title ("[A](a.pdf "Title")").
 */
export function markdownLinkDestinations(s: string): string[] {
	const out: string[] = [];
	for (let i = s.indexOf("]("); i !== -1; i = s.indexOf("](", i + 2)) {
		let j = i + 2;
		while (s[j] === " ") j++;
		if (s[j] === "<") {
			const close = s.indexOf(">", j + 1);
			if (close === -1) continue;
			out.push(s.slice(j + 1, close));
			continue;
		}
		let depth = 0;
		let k = j;
		for (; k < s.length; k++) {
			const c = s[k];
			if (c === "\\") {
				k++;
				continue;
			}
			if (c === "(") depth++;
			else if (c === ")") {
				if (depth === 0) break;
				depth--;
			} else if (c === " " && depth === 0) break;
		}
		if (k > j && k <= s.length) out.push(s.slice(j, k).replace(/\\([()])/g, "$1"));
	}
	return out;
}

function decodeLink(s: string): string {
	try {
		return decodeURI(s);
	} catch {
		return s;
	}
}

function asText(v: unknown): string | null {
	if (typeof v === "string" && v.trim()) return v.trim();
	if (typeof v === "number") return String(v);
	return null;
}

/**
 * Property names to use. When Stacks is installed and `useStacks` is on, its own field
 * mapping comes first, so a renamed "pdf" property is found; the plugin's own names stay
 * as fallbacks, so notes written before a rename keep working.
 */
export function referenceProps(app: App, own: ReferenceProps, useStacks: boolean): ReferenceProps {
	if (!useStacks) return own;
	const names = stacksPropertyNames(app);
	if (!names) return own;
	const merge = (first: unknown[], rest: string[]) => [...new Set([...first.filter((n): n is string => typeof n === "string" && n.length > 0), ...rest])];
	return {
		links: merge([names.pdf, names.attachments], own.links),
		titles: merge([names.title], own.titles),
		citekeys: merge([names.citekey], own.citekeys),
	};
}

function stacksPropertyNames(app: App): Record<string, string> | null {
	// Stacks keeps its field mapping in settings.propertyNames (logical key -> property name).
	const plugins = (app as unknown as { plugins?: { getPlugin?: (id: string) => unknown } }).plugins;
	const stacks = plugins?.getPlugin?.("stacks") as { settings?: { propertyNames?: Record<string, string> } } | null | undefined;
	const names = stacks?.settings?.propertyNames;
	return names && typeof names === "object" ? names : null;
}

/** Maps document paths to the notes that link to them through the given properties. */
export class ReferenceIndex {
	private byDocument = new Map<string, Reference>();

	constructor(
		private app: App,
		private props: ReferenceProps,
	) {}

	/** Rebuild from the metadata cache. Cheap: frontmatter only, no file reads. */
	build(): this {
		this.byDocument.clear();
		const { metadataCache } = this.app;
		for (const note of this.app.vault.getMarkdownFiles()) {
			const fm = metadataCache.getFileCache(note)?.frontmatter;
			if (!fm) continue;
			for (const prop of this.props.links) {
				for (const target of linkTargets(fm[prop])) {
					const doc = metadataCache.getFirstLinkpathDest(target, note.path);
					if (doc && !this.byDocument.has(doc.path)) this.byDocument.set(doc.path, this.describe(note, fm));
				}
			}
		}
		return this;
	}

	get(documentPath: string): Reference | null {
		return this.byDocument.get(documentPath) ?? null;
	}

	get size(): number {
		return this.byDocument.size;
	}

	private describe(note: TFile, fm: Record<string, unknown>): Reference {
		const first = (props: string[]) => props.map((p) => asText(fm[p])).find((v) => v !== null) ?? null;
		return { path: note.path, title: first(this.props.titles) ?? note.basename, citekey: first(this.props.citekeys) };
	}
}
