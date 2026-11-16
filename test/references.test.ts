import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { App } from "obsidian";
import { linkTargets, markdownLinkDestinations, ReferenceIndex, referenceProps } from "../src/references";

describe("linkTargets", () => {
	it("reads wikilinks, with subpaths and aliases dropped", () => {
		assert.deepEqual(linkTargets("[[smith2020.pdf]]"), ["smith2020.pdf"]);
		assert.deepEqual(linkTargets("[[Attachments/smith2020.pdf#page=3|Smith]]"), ["Attachments/smith2020.pdf"]);
	});

	it("reads Markdown links, decoding spaces", () => {
		assert.deepEqual(linkTargets("[Smith](Attachments/Smith%202020.pdf)"), ["Attachments/Smith 2020.pdf"]);
		assert.deepEqual(linkTargets("[Smith](<Attachments/Smith 2020.pdf>)"), ["Attachments/Smith 2020.pdf"]);
	});

	it("reads Markdown links with parentheses, titles and angle brackets", () => {
		assert.deepEqual(linkTargets("[A](Attachments/Smith%20(2020).pdf)"), ["Attachments/Smith (2020).pdf"]);
		assert.deepEqual(linkTargets('[A](Attachments/smith2020.pdf "Smith 2020")'), ["Attachments/smith2020.pdf"]);
		assert.deepEqual(linkTargets("[A](<Attachments/Smith (2020).pdf> 'Title')"), ["Attachments/Smith (2020).pdf"]);
		assert.deepEqual(linkTargets("[A](a\\).pdf)"), ["a).pdf"]);
		assert.deepEqual(markdownLinkDestinations("[a](x.pdf) and [b](y%20(1).pdf#page=2)"), ["x.pdf", "y%20(1).pdf#page=2"]);
	});

	it("reads bare paths and lists, skips URLs and non-strings", () => {
		assert.deepEqual(linkTargets(["[[a.pdf]]", "b.epub", 3, null, "https://example.org/x.pdf"]), ["a.pdf", "b.epub"]);
		assert.deepEqual(linkTargets(undefined), []);
		assert.deepEqual(linkTargets("  "), []);
	});
});

/** Just enough of App for ReferenceIndex: notes with frontmatter, and link resolution by name. */
function fakeApp(notes: Record<string, Record<string, unknown>>, documents: string[], stacks?: Record<string, string>): App {
	const files = Object.keys(notes).map((path) => ({ path, basename: path.split("/").pop()!.replace(/\.md$/, "") }));
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: {
			getFileCache: (f: { path: string }) => ({ frontmatter: notes[f.path] }),
			getFirstLinkpathDest: (link: string) => {
				const hit = documents.find((d) => d === link || d.endsWith(`/${link}`));
				return hit ? { path: hit } : null;
			},
		},
		plugins: { getPlugin: (id: string) => (id === "stacks" && stacks ? { settings: { propertyNames: stacks } } : null) },
	} as unknown as App;
}

describe("ReferenceIndex", () => {
	const own = { links: ["pdf", "attachments"], titles: ["title"], citekeys: ["citekey"] };

	it("maps a document to the note that links it, with title and citekey", () => {
		const app = fakeApp(
			{
				"References/smith2020.md": { title: "On Covenants", citekey: "smith2020", pdf: "[[smith2020.pdf]]" },
				"References/jones.md": { attachments: ["[[jones-a.epub]]"] },
				"Notes/other.md": { tags: ["x"] },
			},
			["archive/zotero/smith2020.pdf", "archive/zotero/jones-a.epub"],
		);
		const idx = new ReferenceIndex(app, own).build();
		assert.equal(idx.size, 2);
		assert.deepEqual(idx.get("archive/zotero/smith2020.pdf"), { path: "References/smith2020.md", title: "On Covenants", citekey: "smith2020" });
		assert.deepEqual(idx.get("archive/zotero/jones-a.epub"), { path: "References/jones.md", title: "jones", citekey: null });
		assert.equal(idx.get("archive/zotero/missing.pdf"), null);
	});

	it("uses Stacks' property names when Stacks is installed", () => {
		const app = fakeApp({ "R/a.md": { Fulltext: "[[a.pdf]]", Name: "A Title", Key: "a2020" } }, ["a.pdf"], { pdf: "Fulltext", attachments: "Files", title: "Name", citekey: "Key" });
		const props = referenceProps(app, own, true);
		assert.deepEqual(props, { links: ["Fulltext", "Files", "pdf", "attachments"], titles: ["Name", "title"], citekeys: ["Key", "citekey"] });
		assert.deepEqual(new ReferenceIndex(app, props).build().get("a.pdf"), { path: "R/a.md", title: "A Title", citekey: "a2020" });
		assert.deepEqual(referenceProps(app, own, false), own);
	});

	it("keeps notes written before a Stacks property rename", () => {
		const app = fakeApp(
			{
				"R/new.md": { Fulltext: "[[new.pdf]]", Name: "New", Key: "new2024" },
				"R/old.md": { pdf: "[[old.pdf]]", title: "Old", citekey: "old1999" },
			},
			["new.pdf", "old.pdf"],
			{ pdf: "Fulltext", attachments: "Files", title: "Name", citekey: "Key" },
		);
		const idx = new ReferenceIndex(app, referenceProps(app, own, true)).build();
		assert.deepEqual(idx.get("old.pdf"), { path: "R/old.md", title: "Old", citekey: "old1999" });
		assert.deepEqual(idx.get("new.pdf"), { path: "R/new.md", title: "New", citekey: "new2024" });
	});

	it("falls back to its own names without Stacks", () => {
		assert.deepEqual(referenceProps(fakeApp({}, []), own, true), own);
	});
});
