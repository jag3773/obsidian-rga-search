import assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { activeUserConfig, customAdapters, extraGlobs, KEYNOTE_SPOTLIGHT_JS, opensInObsidian, openTarget, rgaConfig, searchGlobs, stripJsonc, userConfigPath } from "../src/adapters";
import { searchArgs } from "../src/rga";
import { NodeModules, Runner } from "../src/runner";

const scripts = { keynoteSpotlight: "/p/adapters/keynote-spotlight.sh", keynoteExport: "/p/adapters/keynote-export.sh" };
const has = (program: string) => cp.spawnSync(program, ["--version"]).status === 0;
/** pandoc 3.8.3 and later read PowerPoint. */
const pandocReadsPptx = () => has("pandoc") && /^pptx$/m.test(cp.spawnSync("pandoc", ["--list-input-formats"], { encoding: "utf8" }).stdout);

describe("extra file types", () => {
	it("adds each type's globs to the configured ones", () => {
		assert.deepEqual(extraGlobs({ office: false, keynote: "off" }), []);
		assert.deepEqual(searchGlobs(["*.pdf", "*.epub"], { office: true, keynote: "spotlight" }), ["*.pdf", "*.epub", "*.pptx", "*.xlsx", "*.key"]);
		// Not twice, whatever the case.
		assert.deepEqual(searchGlobs(["*.pdf", "*.KEY"], { office: false, keynote: "export" }), ["*.pdf", "*.KEY"]);
		// No globs means every file, and stays that way.
		assert.deepEqual(searchGlobs([], { office: true, keynote: "spotlight" }), []);
	});

	it("gives each way of reading Keynote its own adapter, so each has its own cache", () => {
		assert.deepEqual(customAdapters({ office: false, keynote: "off" }, scripts), []);
		const spotlight = customAdapters({ office: false, keynote: "spotlight" }, scripts);
		const exported = customAdapters({ office: false, keynote: "export" }, scripts);
		assert.deepEqual(spotlight.map((a) => [a.name, a.binary, a.args, a.output_path_hint]), [["rga_search_keynote_spotlight", "/bin/sh", [scripts.keynoteSpotlight], undefined]]);
		// The exported PDF goes on to rga's PDF reader, which labels its pages.
		assert.deepEqual(exported.map((a) => [a.name, a.args, a.output_path_hint]), [["rga_search_keynote_export", [scripts.keynoteExport], "${input_virtual_path}.pdf"]]);
		const office = customAdapters({ office: true, keynote: "off" }, scripts)[0];
		assert.deepEqual([office.binary, office.extensions, office.args], ["pandoc", ["pptx", "xlsx"], ["--from=$input_file_extension", "--to=plain", "--wrap=none"]]);
		// rga allows only a-z, 0-9 and _ in names.
		for (const a of [...spotlight, ...exported, office]) assert.match(a.name, /^[a-z0-9_]+$/);
	});

	it("reads rga's config.jsonc, comments and trailing commas included", () => {
		const text = `{
  // a comment, with "quotes"
  "$schema": "./config.v1.schema.json", /* and a block */
  "url": "http://example.com/a//b", // slashes inside a string stay
  "custom_adapters": [ { "name": "mine", "note": "a \\" quote" }, ],
}`;
		assert.deepEqual(JSON.parse(stripJsonc(text)), { $schema: "./config.v1.schema.json", url: "http://example.com/a//b", custom_adapters: [{ name: "mine", note: 'a " quote' }] });
	});

	it("leaves strings alone, even ones holding a comma before a bracket", () => {
		const text = `{ "custom_adapters": [ { "name": "sed", "args": ["s/a,}/x/", "a,]b", "a , ] b", "// not a comment"], }, ], }`;
		assert.deepEqual(JSON.parse(stripJsonc(text)), { custom_adapters: [{ name: "sed", args: ["s/a,}/x/", "a,]b", "a , ] b", "// not a comment"] }] });
		// A trailing comma followed by a comment, then the bracket.
		assert.deepEqual(JSON.parse(stripJsonc(`[1, 2, // two\n]`)), [1, 2]);
	});

	it("merges into the config rga would use: an inherited RGA_CONFIG before the config file", () => {
		const inherited = JSON.stringify({ max_archive_recursion: 2, custom_adapters: [{ name: "mine" }] });
		let read = 0;
		const file = () => (read++, `{ "custom_adapters": [ { "name": "from_file" } ] }`);
		assert.equal(activeUserConfig({ RGA_CONFIG: inherited }, file), inherited);
		assert.equal(read, 0, "rga ignores the file when RGA_CONFIG is set");
		assert.match(activeUserConfig({}, file) ?? "", /from_file/);
		assert.match(activeUserConfig({ RGA_CONFIG: " " }, file) ?? "", /from_file/);
		assert.equal(activeUserConfig({}, () => null), null);
		const adapters = customAdapters({ office: true, keynote: "off" }, scripts);
		assert.deepEqual(JSON.parse(rgaConfig(activeUserConfig({ RGA_CONFIG: inherited }, () => null), adapters) ?? ""), { max_archive_recursion: 2, custom_adapters: [{ name: "mine" }, ...adapters] });
	});

	it("keeps the user's own config and adapters alongside the plugin's", () => {
		const adapters = customAdapters({ office: true, keynote: "off" }, scripts);
		assert.equal(rgaConfig("{}", []), null, "nothing to add: rga reads the user's file itself");
		const user = `{ "$schema": "./x.json", "max_archive_recursion": 3, "custom_adapters": [ { "name": "mine" }, { "name": "rga_search_office", "old": true } ] }`;
		assert.deepEqual(JSON.parse(rgaConfig(user, adapters) ?? ""), { max_archive_recursion: 3, custom_adapters: [{ name: "mine" }, ...adapters] });
		assert.deepEqual(JSON.parse(rgaConfig(null, adapters) ?? ""), { custom_adapters: adapters });
		assert.deepEqual(JSON.parse(rgaConfig("not json", adapters) ?? ""), { custom_adapters: adapters });
	});

	it("finds rga's own config file on each platform", () => {
		assert.equal(userConfigPath("darwin", "/Users/a", {}), "/Users/a/Library/Application Support/ripgrep-all/config.jsonc");
		assert.equal(userConfigPath("linux", "/home/a", {}), "/home/a/.config/ripgrep-all/config.jsonc");
		assert.equal(userConfigPath("linux", "/home/a", { XDG_CONFIG_HOME: "/cfg" }), "/cfg/ripgrep-all/config.jsonc");
		assert.equal(userConfigPath("win32", "C:\\Users\\a", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }), "C:\\Users\\a\\AppData\\Roaming\\ripgrep-all\\config\\config.jsonc");
	});

	it("opens types Obsidian has no view for in their default app", () => {
		const registered = (ext: string) => ["pdf", "md", "png"].includes(ext);
		assert.equal(opensInObsidian("a/b.PDF", registered), true);
		assert.equal(opensInObsidian("a/Deck.key", registered), false);
		assert.equal(opensInObsidian("a.b/noext", registered), false);
		// The file's own path goes to the default app, "#" and all; Obsidian gets the link.
		assert.deepEqual(openTarget("archive/Deck #1.pptx", "archive/Deck #1.pptx", registered), { app: "default", path: "archive/Deck #1.pptx" });
		assert.deepEqual(openTarget("a/b.pdf", "a/b.pdf#page=3", registered), { app: "obsidian", link: "a/b.pdf#page=3" });
	});
});

describe("extra file types with the real rga", { skip: !(has("rga") && pandocReadsPptx()) && "needs rga and pandoc 3.8.3 or later" }, () => {
	let dir: string;
	const node: NodeModules = { cp, fs, path, os, process };
	before(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "rga-search-types-"));
		fs.writeFileSync(path.join(dir, "slides.md"), "# First slide\n\nA covenant of salt.\n\n# Second slide\n\nNothing else.\n");
		cp.execFileSync("pandoc", ["slides.md", "-o", "Deck.pptx"], { cwd: dir });
	});
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	const search = (config: string | null) =>
		new Runner(node, { rgaPath: "", cwd: dir, env: { ...(config ? { RGA_CONFIG: config } : {}), XDG_CACHE_HOME: path.join(dir, "cache") } }).run(
			[`--rga-cache-path=${path.join(dir, "cache")}`, ...searchArgs({ query: "covenant of salt", regex: false, folders: [], globs: ["*.pptx"], maxPerFile: 5 })],
		).done;

	it("finds text in PowerPoint files only with the plugin's adapter", async () => {
		assert.deepEqual((await search(null)).hits, []);
		const out = await search(rgaConfig(null, customAdapters({ office: true, keynote: "off" }, scripts)));
		assert.equal(out.error, null);
		assert.deepEqual(out.hits.map((h) => [h.path, h.text.slice(...h.ranges[0])]), [["Deck.pptx", "covenant of salt"]]);
	});
});

describe("Keynote text from Spotlight", { skip: process.platform !== "darwin" && "macOS only" }, () => {
	let dir: string;
	before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "rga-search-spotlight-"))));
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("reads mdimport's escaped text back as plain text", () => {
		// Any file Spotlight can read goes through the same parsing as a deck.
		const text = 'Curly ’quotes’, a "straight" one, a back\\slash\nand an – en dash.';
		fs.writeFileSync(path.join(dir, "it's here.txt"), text);
		fs.writeFileSync(path.join(dir, "spotlight.js"), KEYNOTE_SPOTLIGHT_JS);
		const out = cp.execFileSync("/usr/bin/osascript", ["-l", "JavaScript", path.join(dir, "spotlight.js"), path.join(dir, "it's here.txt")], { encoding: "utf8" });
		assert.equal(out.replace(/\n$/, ""), text);
	});
});
