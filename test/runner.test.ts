import assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { searchArgs, warmArgs } from "../src/rga";
import { NodeModules, Runner } from "../src/runner";

const windows = process.platform === "win32";

/** Node's modules, with a chosen PATH. */
function modules(PATH: string): NodeModules {
	return { cp, fs, path, os, process: { env: { ...process.env, PATH }, platform: process.platform, kill: process.kill.bind(process) } as unknown as typeof process };
}

describe("Runner with a stand-in rga", { skip: windows && "uses a shell script" }, () => {
	let dir: string;
	const fake = (body: string) => {
		const p = path.join(dir, "rga");
		fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
		return p;
	};
	const match = (file: string, n: number) => JSON.stringify({ type: "match", data: { path: { text: `./${file}` }, lines: { text: `Page ${n}: hit ${n}\n` }, submatches: [{ start: 8, end: 11 }] } });

	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "rga-search-test-"));
	});
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("finds rga on PATH and collects its matches", async () => {
		fake(`printf '%s\\n' '${match("a.pdf", 1)}'; echo '{"type":"end","data":{}}'; printf '%s\\n' '${match("b.pdf", 2)}'`);
		const out = await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run(["x"]).done;
		assert.equal(out.error, null);
		assert.deepEqual(out.hits.map((h) => [h.path, h.page, h.text.slice(...h.ranges[0])]), [["a.pdf", 1, "hit"], ["b.pdf", 2, "hit"]]);
	});

	it("passes arguments through untouched and runs in the vault folder", async () => {
		const exe = fake(`printf '%s\\n' "$@" > args.txt`);
		// No shell sits between the plugin and rga, so a query is never interpreted as a command.
		const query = "a b; $(touch pwned) `touch pwned`";
		const out = await new Runner(modules("/nonexistent"), { rgaPath: exe, cwd: dir }).run(["--regexp", query, "--", "."]).done;
		assert.equal(out.error, null);
		assert.deepEqual(fs.readFileSync(path.join(dir, "args.txt"), "utf8").trim().split("\n"), ["--regexp", query, "--", "."]);
		assert.equal(fs.existsSync(path.join(dir, "pwned")), false);
	});

	it("treats exit 1 as no matches and reports real errors from stderr", async () => {
		fake("exit 1");
		assert.deepEqual(await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done, { hits: [], truncated: false, cancelled: false, error: null, warning: null, unreadable: [] });
		fake("echo 'rga: bad regex' >&2; exit 2");
		assert.equal((await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done).error, "rga: bad regex");
	});

	// rga's report for a file it can't extract, as printed for a damaged PDF in a real library.
	const report = (file: string) =>
		[
			`rg: ${file}: preprocessor command failed: '"/opt/homebrew/bin/rga-preproc" "${file}"': `,
			"-".repeat(79),
			`/vault/${file} adapter: poppler`,
			"Syntax Error: Couldn't read xref table",
			"Error: copying adapter output to stdout",
			"-".repeat(79),
		].join("\n");

	it("reports unreadable files as a warning alongside matches", async () => {
		fs.writeFileSync(path.join(dir, "stderr.txt"), `${report("archive/broken.pdf")}\n${report("archive/bad.epub")}\n`);
		fake(`printf '%s\\n' '${match("a.pdf", 1)}'; cat stderr.txt >&2; exit 2`);
		const out = await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done;
		assert.equal(out.error, null);
		assert.equal(out.hits.length, 1);
		assert.deepEqual(out.unreadable, ["archive/broken.pdf", "archive/bad.epub"]);
		assert.match(out.warning!, /^2 files couldn't be read.*broken\.pdf, bad\.epub\.$/);
	});

	it("says no matches, not an error, when only unreadable files failed", async () => {
		fs.writeFileSync(path.join(dir, "stderr.txt"), `${report("archive/broken.pdf")}\n`);
		fake("cat stderr.txt >&2; exit 2");
		const out = await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done;
		assert.equal(out.error, null);
		assert.deepEqual(out.hits, []);
		assert.match(out.warning!, /^1 file couldn't be read/);
	});

	it("keeps a whole-search error over several lines, apart from unreadable-file reports", async () => {
		fs.writeFileSync(path.join(dir, "stderr.txt"), `${report("archive/broken.pdf")}\nrg: regex parse error:\n    (?:(unclosed)\nerror: unclosed group\n`);
		fake("cat stderr.txt >&2; exit 2");
		const out = await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done;
		assert.equal(out.error, "rg: regex parse error:\n    (?:(unclosed)\nerror: unclosed group");
	});

	it("reports a problem alongside matches when it isn't about one file", async () => {
		fake(`printf '%s\\n' '${match("a.pdf", 1)}'; echo 'rg: something went wrong' >&2; exit 2`);
		const out = await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done;
		assert.equal(out.error, null);
		assert.equal(out.warning, "rg: something went wrong");
	});

	it("on Windows, ends the whole process tree with taskkill", async () => {
		// A Windows-style PATH (";"-separated) hides /bin from the script, so sleep is named in full.
		fake(`printf '%s\\n' '${match("a.pdf", 1)}'; /bin/sleep 5`);
		const calls: string[][] = [];
		const node = modules(dir);
		const fakeCp = {
			...cp,
			spawn: cp.spawn,
			execFile: ((file: string, args: string[], _opts: unknown, cb: () => void) => {
				calls.push([file, ...args]);
				cb();
			}) as unknown as typeof cp.execFile,
		};
		const win = { ...node, cp: fakeCp as typeof cp, process: { ...node.process, platform: "win32", env: node.process.env } as unknown as typeof process };
		// PATH lookup would want rga.exe, so give the script's path directly.
		const handle = new Runner(win, { rgaPath: path.join(dir, "rga"), cwd: dir }).run([]);
		await new Promise((r) => setTimeout(r, 200));
		handle.cancel();
		const out = await handle.done;
		assert.equal(out.cancelled, true, "still running when cancelled");
		assert.equal(calls.length, 1);
		assert.deepEqual([calls[0][0], calls[0][1], calls[0][3], calls[0][4]], ["taskkill", "/pid", "/T", "/F"]);
		assert.match(calls[0][2], /^\d+$/);
		process.kill(Number(calls[0][2]), "SIGTERM");
	});

	it("stops at the result limit", async () => {
		fake(`i=1; while [ $i -le 1000 ]; do printf '%s\\n' '${match("a.pdf", 1)}'; i=$((i+1)); done; sleep 5`);
		const started = Date.now();
		const out = await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([], 10).done;
		assert.equal(out.hits.length, 10);
		assert.equal(out.truncated, true);
		assert.ok(Date.now() - started < 2000, "rga is stopped, not waited for");
	});

	it("cancels a running search", async () => {
		fake(`printf '%s\\n' '${match("a.pdf", 1)}'; sleep 5`);
		const handle = new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]);
		setTimeout(() => handle.cancel(), 100);
		const started = Date.now();
		const out = await handle.done;
		assert.ok(Date.now() - started < 2000, "cancel settles at once");
		assert.equal(out.cancelled, true);
		assert.equal(out.error, null);
	});

	it("stops the processes rga started, not only rga", async () => {
		fake(`sleep 30 & echo $! > child.pid; wait`);
		const handle = new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]);
		await new Promise((r) => setTimeout(r, 300));
		const pid = Number(fs.readFileSync(path.join(dir, "child.pid"), "utf8"));
		handle.cancel();
		await handle.done;
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0), "the child is gone");
	});

	it("explains a missing rga", async () => {
		const out = await new Runner(modules(path.join(dir, "empty")), { rgaPath: "", cwd: dir }).run([]).done;
		// The extended PATH includes /opt/homebrew/bin, so on a machine with rga installed it is found there.
		if (out.error) assert.match(out.error, /ripgrep-all|brew install/);
		const missing = await new Runner(modules(dir), { rgaPath: path.join(dir, "nope"), cwd: dir }).run([]).done;
		assert.match(missing.error!, /not found at/);
	});
});

// The real thing, when rga is installed: page labels from poppler, and the cache warm-up.
const real = (() => {
	try {
		return new Runner(modules(process.env.PATH ?? ""), { rgaPath: "", cwd: "." }).resolve();
	} catch {
		return null;
	}
})();

describe("Runner with the real rga", { skip: !real && "rga is not installed" }, () => {
	let vault: string;
	before(() => {
		vault = fs.mkdtempSync(path.join(os.tmpdir(), "rga-search-vault-"));
		fs.mkdirSync(path.join(vault, "archive", "zotero"), { recursive: true });
		fs.copyFileSync(path.join("test", "fixtures", "Covenant Paper.pdf"), path.join(vault, "archive", "zotero", "Covenant Paper.pdf"));
		fs.copyFileSync(path.join("test", "fixtures", "Line Breaks.pdf"), path.join(vault, "archive", "Line Breaks.pdf"));
		fs.writeFileSync(path.join(vault, "note.md"), "covenant in a note, which is left to Obsidian's search\n");
	});
	after(() => fs.rmSync(vault, { recursive: true, force: true }));

	const find = async (query: string) => {
		const runner = new Runner(modules(process.env.PATH ?? ""), { rgaPath: "", cwd: vault });
		const out = await runner.run(searchArgs({ query, regex: false, folders: ["archive"], globs: ["*.pdf"], maxPerFile: 5 })).done;
		assert.equal(out.error, null);
		return out.hits.map((h) => ({ path: h.path, page: h.page, match: h.ranges.map(([a, b]) => h.text.slice(a, b)) }));
	};

	it("finds a phrase that breaks across lines", async () => {
		assert.deepEqual(await find("wasted an interview"), [{ path: "archive/Line Breaks.pdf", page: 2, match: ["wasted an interview"] }]);
	});

	it("finds a phrase that breaks across pages, on the page where it starts", async () => {
		assert.deepEqual(await find("the covenant of grace"), [{ path: "archive/Line Breaks.pdf", page: 2, match: ["the covenant of   grace"] }]);
	});

	it("matches a straight apostrophe to the curly one pdftotext gives", async () => {
		assert.deepEqual(await find("it's a lesson"), [{ path: "archive/Line Breaks.pdf", page: 2, match: ["It’s a lesson"] }]);
	});

	it("gives each match on consecutive lines its own hit, though rga reports them as one block", async () => {
		const hits = (await find("covenant")).filter((h) => h.path === "archive/Line Breaks.pdf");
		assert.deepEqual(
			hits.map((h) => [h.page, h.match]),
			[
				[2, ["covenant"]],
				[4, ["Covenant"]],
				[4, ["covenant"]],
				[4, ["covenant"]],
			],
		);
	});

	it("finds a word pdftotext rejoined after hyphenation", async () => {
		assert.deepEqual(await find("second interview"), [{ path: "archive/Line Breaks.pdf", page: 4, match: ["second interview"] }]);
	});

	it("matches case exactly when the query has a capital", async () => {
		assert.deepEqual(await find("It's a lesson"), [{ path: "archive/Line Breaks.pdf", page: 2, match: ["It’s a lesson"] }]);
		assert.deepEqual(await find("WASTED an interview"), []);
	});

	it("finds text in a PDF with its page numbers", async () => {
		const runner = new Runner(modules(process.env.PATH ?? ""), { rgaPath: "", cwd: vault });
		const out = await runner.run(searchArgs({ query: "Covenant", regex: false, folders: ["archive/zotero"], globs: ["*.pdf"], maxPerFile: 5 })).done;
		assert.equal(out.error, null);
		// "Covenant" has a capital, so smart case makes it case-sensitive: no match.
		assert.equal(out.hits.length, 0);
		const lower = await runner.run(searchArgs({ query: "covenant", regex: false, folders: ["archive/zotero"], globs: ["*.pdf"], maxPerFile: 5 })).done;
		assert.deepEqual(
			lower.hits.map((h) => [h.path, h.page, h.text.slice(...h.ranges[0])]),
			[
				["archive/zotero/Covenant Paper.pdf", 2, "covenant"],
				["archive/zotero/Covenant Paper.pdf", 3, "covenant"],
			],
		);
	});

	it("warms the cache without errors", async () => {
		const runner = new Runner(modules(process.env.PATH ?? ""), { rgaPath: "", cwd: vault });
		const out = await runner.run(warmArgs([], ["*.pdf"])).done;
		assert.equal(out.error, null);
		assert.equal(out.hits.length, 0);
		assert.ok(runner.hasProgram("pdftotext"));
		assert.match((await runner.version()).text, /ripgrep-all/);
	});
});
