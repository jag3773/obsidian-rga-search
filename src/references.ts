import type { App, TFile } from "obsidian";

/** The reference note that links to a document, as a result row shows it. */
export interface Reference {
	/** The note's path. */
	path: string;
	/** Its title property, else its file name. */
	title: string;
	citekey: string | null;
}

/** Which frontmatter properties to read. */
export interface ReferenceProps {
	/** Properties that link to the document, e.g. ["pdf", "attachments"]. */
	links: string[];
	title: string;
	citekey: string;
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
	for (const m of v.matchAll(/\[[^\]]*\]\(<?([^)>]+?)>?\)/g)) out.push(decodeLink(m[1].replace(/#.*$/, "").trim()));
	if (out.length) return out.filter(Boolean);
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return [];
	return [v.replace(/#.*$/, "").trim()].filter(Boolean);
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
 * mapping wins, so a renamed "pdf" property is still found.
 */
export function referenceProps(app: App, own: ReferenceProps, useStacks: boolean): ReferenceProps {
	if (!useStacks) return own;
	const names = stacksPropertyNames(app);
	if (!names) return own;
	const links = [names.pdf, names.attachments].filter((n): n is string => typeof n === "string" && n.length > 0);
	return {
		links: links.length ? links : own.links,
		title: names.title || own.title,
		citekey: names.citekey || own.citekey,
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
		return { path: note.path, title: asText(fm[this.props.title]) ?? note.basename, citekey: asText(fm[this.props.citekey]) };
	}
}
