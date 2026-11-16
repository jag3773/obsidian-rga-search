import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanFolder, documentLink, excerpt, groupByDocument, LineSplitter, parseLine, searchArgs, searchPath, splitList, unreadableFile, unreadableWarning, vaultPath, warmArgs } from "../src/rga";

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
		const hit = parseLine(line);
		assert.deepEqual(hit, { path: "Test Paper.pdf", page: 2, text: "Second page mentions covenant theology", ranges: [[21, 29]] });
		assert.equal(hit!.text.slice(21, 29), "covenant");
	});

	it("converts UTF-8 byte offsets to string offsets", () => {
		const hit = parseLine(matchLine("a/Greek.pdf", "Page 7: ἐν ἀρχῇ ἦν ὁ λόγος καὶ ὁ λόγος\n", "λόγος"))!;
		assert.equal(hit.page, 7);
		const [[a, b]] = hit.ranges;
		assert.equal(hit.text.slice(a, b), "λόγος");
	});

	it("handles astral characters (surrogate pairs) before the match", () => {
		const hit = parseLine(matchLine("x.epub", "𝔊𝔬𝔡 so loved\n", "loved"))!;
		assert.equal(hit.page, null);
		assert.equal(hit.text.slice(...hit.ranges[0]), "loved");
	});

	it("decodes base64 paths and lines that are not valid UTF-8", () => {
		const b64 = (s: string) => btoa(s);
		const line = JSON.stringify({ type: "match", data: { path: { bytes: b64("dir/caf\xe9.pdf") }, lines: { bytes: b64("Page 1: hello\n") }, submatches: [{ start: 8, end: 13 }] } });
		const hit = parseLine(line)!;
		assert.equal(hit.page, 1);
		assert.equal(hit.text, "hello");
		assert.deepEqual(hit.ranges, [[0, 5]]);
		assert.ok(hit.path.startsWith("dir/caf"));
	});

	it("keeps lines without a page label whole (EPUB, DOCX)", () => {
		const hit = parseLine(matchLine("book.epub", "In the beginning was the Word\n", "Word"))!;
		assert.equal(hit.page, null);
		assert.equal(hit.text, "In the beginning was the Word");
	});

	it("ignores begin, end, summary, blank and malformed lines", () => {
		assert.equal(parseLine('{"type":"begin","data":{"path":{"text":"a.pdf"}}}'), null);
		assert.equal(parseLine('{"type":"summary","data":{}}'), null);
		assert.equal(parseLine(""), null);
		assert.equal(parseLine("not json"), null);
		assert.equal(parseLine("null"), null);
		assert.equal(parseLine('{"type":"match"}'), null);
	});
});

describe("searchArgs", () => {
	it("searches literally, smart-case, with globs, in the given folders", () => {
		assert.deepEqual(searchArgs({ query: "-covenant", regex: false, folders: ["/archive/zotero/", ""], globs: ["*.pdf", " *.epub "], maxPerFile: 5 }), [
			"--rga-cache-max-blob-len=100000000",
			"--json",
			"--smart-case",
			"--max-count",
			"5",
			"--fixed-strings",
			"--iglob",
			"*.pdf",
			"--iglob",
			"*.epub",
			"--regexp",
			"-covenant",
			"--",
			"archive/zotero",
		]);
	});

	it("searches the whole vault and allows regular expressions", () => {
		const args = searchArgs({ query: "cov.nant", regex: true, folders: [], globs: [], maxPerFile: 0 });
		assert.ok(!args.includes("--fixed-strings"));
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
		assert.equal(unreadableWarning(["a/x.pdf"]), "1 file couldn't be read (damaged, or not really that type): x.pdf.");
		assert.match(unreadableWarning(["a", "b", "c", "d", "e"])!, /^5 files .*: a, b, c and 2 more\.$/);
	});
});
