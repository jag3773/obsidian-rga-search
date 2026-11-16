import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanFolder, documentLink, excerpt, groupByDocument, joinLines, LineSplitter, parseLine, phrasePattern, searchArgs, splitBlock, searchPath, splitList, unreadableFile, unreadableWarning, vaultPath, warmArgs } from "../src/rga";

/** A match line as rga --json prints it, with byte offsets computed from the text. */
function matchLine(path: string, line: string, needle: string): string {
	const bytes = new TextEncoder().encode(line);
	const at = line.indexOf(needle);
	const start = new TextEncoder().encode(line.slice(0, at)).length;
	const end = start + new TextEncoder().encode(needle).length;
	assert.ok(bytes.length >= end);
	return JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: line }, line_number: null, absolute_offset: 0, submatches: [{ match: { text: needle }, start, end }] } });
}

describe("parseLine", () => {
	it("reads a PDF match: page from the label, ranges moved past it", () => {
		// Recorded from rga 0.10.10 on test/fixtures/Covenant Paper.pdf.
		const line =
			'{"type":"match","data":{"path":{"text":"./Test Paper.pdf"},"lines":{"text":"Page 2: Second page mentions covenant theology\\n"},"line_number":null,"absolute_offset":55,"submatches":[{"match":{"text":"covenant"},"start":29,"end":37}]}}';
		const hit = parseLine(line)[0];
		assert.deepEqual(hit, { path: "Test Paper.pdf", page: 2, text: "Second page mentions covenant theology", ranges: [[21, 29]] });
		assert.equal(hit!.text.slice(21, 29), "covenant");
	});

	it("converts UTF-8 byte offsets to string offsets", () => {
		const hit = parseLine(matchLine("a/Greek.pdf", "Page 7: ἐν ἀρχῇ ἦν ὁ λόγος καὶ ὁ λόγος\n", "λόγος"))[0];
		assert.equal(hit.page, 7);
		const [[a, b]] = hit.ranges;
		assert.equal(hit.text.slice(a, b), "λόγος");
	});

	it("handles astral characters (surrogate pairs) before the match", () => {
		const hit = parseLine(matchLine("x.epub", "𝔊𝔬𝔡 so loved\n", "loved"))[0];
		assert.equal(hit.page, null);
		assert.equal(hit.text.slice(...hit.ranges[0]), "loved");
	});

	it("decodes base64 paths and lines that are not valid UTF-8", () => {
		const b64 = (s: string) => btoa(s);
		const line = JSON.stringify({ type: "match", data: { path: { bytes: b64("dir/caf\xe9.pdf") }, lines: { bytes: b64("Page 1: hello\n") }, submatches: [{ start: 8, end: 13 }] } });
		const hit = parseLine(line)[0];
		assert.equal(hit.page, 1);
		assert.equal(hit.text, "hello");
		assert.deepEqual(hit.ranges, [[0, 5]]);
		assert.ok(hit.path.startsWith("dir/caf"));
	});

	it("keeps lines without a page label whole (EPUB, DOCX)", () => {
		const hit = parseLine(matchLine("book.epub", "In the beginning was the Word\n", "Word"))[0];
		assert.equal(hit.page, null);
		assert.equal(hit.text, "In the beginning was the Word");
	});

	it("ignores begin, end, summary, blank and malformed lines", () => {
		assert.deepEqual(parseLine('{"type":"begin","data":{"path":{"text":"a.pdf"}}}'), []);
		assert.deepEqual(parseLine('{"type":"summary","data":{}}'), []);
		assert.deepEqual(parseLine(""), []);
		assert.deepEqual(parseLine("not json"), []);
		assert.deepEqual(parseLine("null"), []);
		assert.deepEqual(parseLine('{"type":"match"}'), []);
	});
});

describe("searchArgs", () => {
	it("searches a word literally, ignoring case, with globs, in the given folders", () => {
		assert.deepEqual(searchArgs({ query: "-covenant", regex: false, folders: ["/archive/zotero/", ""], globs: ["*.pdf", " *.epub "], maxPerFile: 5 }), [
			"--rga-cache-max-blob-len=100000000",
			"--json",
			"--max-count",
			"5",
			"--ignore-case",
			// Even one word can run onto the next line when it is hyphenated there.
			"--multiline",
			"--iglob",
			"*.pdf",
			"--iglob",
			"*.epub",
			"--regexp",
			phrasePattern("-covenant"),
			"--",
			"archive/zotero",
		]);
		assert.ok(jsRegex(phrasePattern("-covenant")).test("-covenant"), "a leading hyphen is literal, not a flag");
	});

	it("searches a phrase across lines, and matches case exactly when the query has a capital", () => {
		const args = searchArgs({ query: "wasted an Interview", regex: false, folders: [], globs: [], maxPerFile: 5 });
		assert.ok(args.includes("--multiline"));
		assert.ok(args.includes("--case-sensitive"));
		assert.ok(!args.includes("--smart-case"));
		assert.equal(args[args.indexOf("--regexp") + 1], phrasePattern("wasted an Interview"));
	});

	it("searches the whole vault and allows regular expressions", () => {
		const args = searchArgs({ query: "cov.nant", regex: true, folders: [], globs: [], maxPerFile: 0 });
		assert.ok(args.includes("--smart-case"));
		assert.ok(!args.includes("--multiline"));
		assert.equal(args[args.indexOf("--regexp") + 1], "cov.nant");
		assert.deepEqual(args.slice(-2), ["--", "."]);
		assert.equal(args[args.indexOf("--max-count") + 1], "1");
	});

	it("matches file types ignoring case, so *.pdf finds A.PDF", () => {
		assert.ok(warmArgs([], ["*.pdf"]).includes("--iglob"));
		assert.ok(!searchArgs({ query: "x", regex: false, folders: [], globs: ["*.pdf"], maxPerFile: 1 }).includes("--glob"));
	});

	it("warms without printing matches", () => {
		const args = warmArgs(["Archive"], ["*.pdf"]);
		assert.ok(args.includes("--files-with-matches"));
		assert.deepEqual(args.slice(-2), ["--", "Archive"]);
	});
});

describe("paths", () => {
	it("cleans folders and rga's output paths", () => {
		assert.equal(cleanFolder(" ./Archive/zotero/ "), "Archive/zotero");
		assert.equal(cleanFolder("/"), "");
		assert.equal(vaultPath("./a/b.pdf"), "a/b.pdf");
		assert.equal(vaultPath("a\\b.pdf"), "a/b.pdf");
	});

	it("extends PATH with rga's folder and Homebrew, without duplicates", () => {
		const p = searchPath("/usr/bin:/bin", { platform: "darwin", home: "/Users/me", rgaDir: "/opt/tools" });
		const dirs = p.split(":");
		assert.deepEqual(dirs.slice(0, 4), ["/usr/bin", "/bin", "/opt/tools", "/opt/homebrew/bin"]);
		assert.equal(dirs.filter((d) => d === "/usr/bin").length, 1);
		assert.ok(dirs.includes("/Users/me/.cargo/bin"));
	});

	it("uses ; on Windows", () => {
		assert.ok(searchPath("C:\\Windows", { platform: "win32", home: "C:\\Users\\me" }).startsWith("C:\\Windows;C:\\Users\\me\\scoop\\shims"));
	});

	it("splits lists", () => {
		assert.deepEqual(splitList(" a, b\n,c ,"), ["a", "b", "c"]);
	});
});

describe("results", () => {
	it("links PDF hits to their page", () => {
		assert.equal(documentLink({ path: "a/b.pdf", page: 12 }), "a/b.pdf#page=12");
		assert.equal(documentLink({ path: "a/b.epub", page: null }), "a/b.epub");
		assert.equal(documentLink({ path: "a/b.PDF", page: null }), "a/b.PDF");
	});

	it("groups interleaved hits by document, in order of first appearance", () => {
		const hits = [{ path: "b", n: 1 }, { path: "a", n: 2 }, { path: "b", n: 3 }, { path: "a", n: 4 }];
		assert.deepEqual(groupByDocument(hits).map((h) => h.n), [1, 3, 2, 4]);
	});

	it("excerpts long lines around the first match", () => {
		const text = `${"x".repeat(300)}NEEDLE${"y".repeat(300)}`;
		const ex = excerpt(text, [[300, 306]], 60);
		assert.ok(ex.text.startsWith("…") && ex.text.endsWith("…"));
		assert.equal(ex.text.slice(...ex.ranges[0]), "NEEDLE");
		assert.ok(ex.text.length <= 62);
	});

	it("leaves short lines alone", () => {
		assert.deepEqual(excerpt("short line  ", [[0, 5]]), { text: "short line", ranges: [[0, 5]] });
	});
});

describe("LineSplitter", () => {
	it("joins lines split across chunks", () => {
		const s = new LineSplitter();
		assert.deepEqual(s.push('{"a":'), []);
		assert.deepEqual(s.push('1}\n{"b"'), ['{"a":1}']);
		assert.deepEqual(s.push(":2}\n"), ['{"b":2}']);
		assert.deepEqual(s.push("tail"), []);
		assert.deepEqual(s.flush(), ["tail"]);
	});
});

describe("unreadable files", () => {
	it("finds the file in rga's report line", () => {
		assert.equal(unreadableFile(`rg: ./archive/zotero/Florida 2023.pdf: preprocessor command failed: '"/opt/homebrew/bin/rga-preproc" "x"': `), "archive/zotero/Florida 2023.pdf");
		assert.equal(unreadableFile("rg: regex parse error:"), null);
	});

	it("names up to three files", () => {
		assert.equal(unreadableWarning([]), null);
		assert.equal(unreadableWarning(["a/x.pdf"]), "1 file couldn't be read (damaged, password-protected, or not really that type): x.pdf.");
		assert.match(unreadableWarning(["a", "b", "c", "d", "e"])!, /^5 files .*: a, b, c and 2 more\.$/);
	});
});

describe("phrases across line breaks", () => {
	it("escapes regex characters and joins words with a gap that allows line breaks and page labels", () => {
		const p = phrasePattern("  a.b  (c)  ");
		assert.equal(p, String.raw`a\.b\s(?:\s|Page \d+: )*\(c\)`);
		const re = jsRegex(p);
		assert.ok(re.test("a.b (c)"));
		assert.ok(re.test("a.b\nPage 4: (c)"));
		assert.ok(re.test("a.b\nPage 2: \nPage 2: \nPage 3: (c)"), "across a page break");
		assert.ok(!re.test("axb (c)"), "a dot is literal");
		assert.ok(!re.test("a.b(c)"), "words still need a gap");
	});

	it("matches straight and curly quotes alike", () => {
		const re = jsRegex(phrasePattern(`it's "true"`));
		for (const s of [`it's "true"`, "it’s “true”", "it‘s ”true“"]) assert.ok(re.test(s), s);
	});
});

/** ripgrep's Rust syntax as a JavaScript RegExp: "\x{AD}" is "\u{AD}" with the u flag. */
function jsRegex(rust: string, flags = ""): RegExp {
	return new RegExp(rust.replace(/\\x\{([0-9A-Fa-f]+)\}/g, "\\u{$1}"), `u${flags}`);
}

describe("words hyphenated at a line break", () => {
	const SOFT = "­";
	const re = jsRegex(phrasePattern("interview"), "i");

	it("finds a word split by a hyphen at the end of a line, whatever the hyphen", () => {
		for (const h of ["-", "‐", SOFT]) {
			assert.ok(re.test(`wasted an inter${h}\nPage 10: view because`), JSON.stringify(h));
			assert.ok(re.test(`inter${h}  \nPage 10: \nPage 11: view`), `${JSON.stringify(h)} across a page`);
		}
	});

	it("finds a word with an invisible soft hyphen mid-line", () => {
		assert.ok(re.test(`an inter${SOFT}view`));
	});

	it("doesn't join words split by a dash or a plain line break", () => {
		assert.ok(!re.test("inter–\nPage 1: view"), "en dash");
		assert.ok(!re.test("inter\nPage 1: view"), "no hyphen");
		assert.ok(!re.test("inter- view"), "a hyphen mid-line is a real hyphen, not hyphenation");
	});

	it("matches a typed hyphen to one at a line end", () => {
		const wk = jsRegex(phrasePattern("well-known"), "i");
		assert.ok(wk.test("well-known"));
		assert.ok(wk.test("well‐\nPage 3: known"));
		assert.ok(!wk.test("wellknown"));
	});

	it("still finds phrases, with hyphenation inside any of the words", () => {
		const p = jsRegex(phrasePattern("wasted an interview"), "i");
		assert.ok(p.test(`wasted an\nPage 10: inter${SOFT}\nPage 10: view`));
	});

	it("reads a soft-hyphen split as rga reports it, as one hit with the whole word highlighted", () => {
		// The shape rga gives for a typeset book whose word pdftotext left split ("psycho­" / "analyst").
		const lines = `Page 2: as set out by the postmodern psycho${SOFT}\nPage 2: analyst of that school.\n`;
		const start = new TextEncoder().encode(lines.slice(0, lines.indexOf("psycho"))).length;
		const end = new TextEncoder().encode(lines.slice(0, lines.indexOf("analyst") + 7)).length;
		const msg = JSON.stringify({ type: "match", data: { path: { text: "./b.pdf" }, lines: { text: lines }, submatches: [{ start, end }] } });
		const hits = parseLine(msg);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].page, 2);
		assert.equal(hits[0].text, `as set out by the postmodern psycho${SOFT}analyst of that school.`);
		assert.equal(hits[0].text.slice(...hits[0].ranges[0]).replace(SOFT, ""), "psychoanalyst");
		assert.ok(jsRegex(phrasePattern("psychoanalyst"), "i").test(lines));
	});

	it("joins a hyphenated line to the next without a space, and highlights the whole word", () => {
		const raw = `Page 9: a wasted inter${SOFT}\nPage 9: view because\n`;
		const start = raw.indexOf("inter");
		const end = raw.indexOf("view") + 4;
		const out = joinLines(raw, [[start, end]]);
		assert.equal(out.text, `a wasted inter${SOFT}view because`);
		assert.equal(out.text.slice(...out.ranges[0]).replace(SOFT, ""), "interview");
		assert.equal(joinLines("Page 1: well‐\nPage 1: known\n", []).text, "well‐known");
	});
});

describe("blocks of consecutive matching lines", () => {
	it("splits a block into one hit per line, each with its page", () => {
		// --multiline reports matches on consecutive lines as one block.
		const lines = "Page 4: the covenant\nPage 4: a covenant again\nPage 5: covenant on the next page\n";
		const subs = [...lines.matchAll(/covenant/g)].map((m) => ({ start: m.index!, end: m.index! + 8 }));
		const msg = JSON.stringify({ type: "match", data: { path: { text: "./a.pdf" }, lines: { text: lines }, submatches: subs } });
		assert.deepEqual(
			parseLine(msg).map((h) => [h.page, h.text, h.text.slice(...h.ranges[0])]),
			[
				[4, "the covenant", "covenant"],
				[4, "a covenant again", "covenant"],
				[5, "covenant on the next page", "covenant"],
			],
		);
	});

	it("keeps lines together only where one match runs onto the next", () => {
		const raw = "Page 2: one hit and wasted an\nPage 2: interview here\nPage 2: another hit\n";
		const a = raw.indexOf("hit");
		const b = raw.indexOf("wasted");
		const c = raw.lastIndexOf("hit");
		const parts = splitBlock(raw, [[a, a + 3], [b, raw.indexOf("interview") + 9], [c, c + 3]]);
		assert.deepEqual(
			parts.map((p) => p.raw),
			["Page 2: one hit and wasted an\nPage 2: interview here", "Page 2: another hit"],
		);
		assert.equal(parts[0].ranges.length, 2);
		assert.equal(parts[1].raw.slice(...parts[1].ranges[0]), "hit");
	});

	it("keeps a match that ends at a line break on its own line", () => {
		const raw = "Page 1: alpha\nPage 1: beta\n";
		assert.deepEqual(splitBlock(raw, [[8, 14], [22, 26]]).map((p) => p.raw), ["Page 1: alpha", "Page 1: beta"]);
	});
});

describe("phrases (continued)", () => {

	it("joins a multiline match into one line, without labels, keeping the highlight", () => {
		// Recorded from rga 0.10.10 on test/fixtures/Line Breaks.pdf (searched for "wasted an interview").
		const line =
			'{"type":"match","data":{"path":{"text":"Line Breaks.pdf"},"lines":{"text":"Page 2: essentially wasted an\\nPage 2: interview by arguing my own thesis.\\n"},"line_number":null,"absolute_offset":150,"submatches":[{"match":{"text":"wasted an\\nPage 2: interview"},"start":20,"end":47}]}}';
		const hit = parseLine(line)[0];
		assert.equal(hit.page, 2);
		assert.equal(hit.text, "essentially wasted an interview by arguing my own thesis.");
		assert.deepEqual(hit.ranges.map(([a, b]) => hit.text.slice(a, b)), ["wasted an interview"]);
	});

	it("takes the page where the match starts, across a page break", () => {
		const raw = "Page 2: about the covenant of\nPage 2: \nPage 2: \nPage 3: grace and how\n";
		const start = raw.indexOf("covenant");
		const end = raw.indexOf("grace") + "grace".length;
		const out = joinLines(raw, [[start, end]]);
		assert.equal(out.page, 2);
		assert.equal(out.text, "about the covenant of   grace and how");
		assert.equal(out.text.slice(...out.ranges[0]), "covenant of   grace");
	});

	it("leaves a single labelled line as before", () => {
		assert.deepEqual(joinLines("Page 7: hello world\n", [[14, 19]]), { text: "hello world", page: 7, ranges: [[6, 11]] });
		assert.deepEqual(joinLines("no label\n", [[3, 8]]), { text: "no label", page: null, ranges: [[3, 8]] });
	});
});
