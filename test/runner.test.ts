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
		assert.deepEqual(await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done, { hits: [], truncated: false, cancelled: false, error: null });
		fake("echo 'rga: bad regex' >&2; exit 2");
		assert.equal((await new Runner(modules(dir), { rgaPath: "", cwd: dir }).run([]).done).error, "rga: bad regex");
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
		fs.writeFileSync(path.join(vault, "note.md"), "covenant in a note, which is left to Obsidian's search\n");
	});
	after(() => fs.rmSync(vault, { recursive: true, force: true }));

	it("finds text in a PDF with its page numbers", async () => {
		const runner = new Runner(modules(process.env.PATH ?? ""), { rgaPath: "", cwd: vault });
		const out = await runner.run(searchArgs({ query: "Covenant", regex: false, folders: [], globs: ["*.pdf"], maxPerFile: 5 })).done;
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
