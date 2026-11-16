import { browser, expect } from "@wdio/globals";
import { before, beforeEach, describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

const ID = "rga-search";

/** Records the links the plugin asks Obsidian to open, then lets Obsidian open them. */
async function recordOpenedLinks(): Promise<void> {
	await browser.executeObsidian(({ app }) => {
		const ws = app.workspace as any;
		if (ws.__rgaOpened) return;
		ws.__rgaOpened = [];
		const original = ws.openLinkText.bind(ws);
		ws.openLinkText = (link: string, ...rest: unknown[]) => {
			ws.__rgaOpened.push(link);
			return original(link, ...rest);
		};
	});
}

const openedLinks = () => browser.executeObsidian(({ app }) => (app.workspace as any).__rgaOpened as string[]);
const activePath = () => browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path ?? null);

async function search(query: string): Promise<void> {
	await browser.executeObsidianCommand(`${ID}:search`);
	const input = browser.$(".prompt-input");
	await input.waitForDisplayed();
	await input.setValue(query);
}

/** What each result row shows, in order. */
const rows = () =>
	browser.execute(() =>
		[...document.querySelectorAll(".rga-search-result")].map((el) => ({
			title: el.querySelector(".rga-search-title")?.textContent ?? "",
			page: el.querySelector(".rga-search-page")?.textContent ?? "",
			match: el.querySelector(".rga-search-match")?.textContent ?? "",
			citekey: el.querySelector(".rga-search-citekey")?.textContent ?? "",
			path: el.querySelector(".rga-search-path")?.textContent ?? "",
		})),
	);

describe("RGA Search", function () {
	before(async function () {
		await obsidianPage.resetVault();
		await recordOpenedLinks();
	});

	beforeEach(async function () {
		// Close any search box a failed test left open.
		await browser.execute(() => document.querySelectorAll<HTMLElement>(".modal-close-button").forEach((b) => b.click()));
	});

	it("is enabled and registers its commands", async function () {
		const state = await browser.executeObsidian(({ app }) => {
			const plugins = (app as any).plugins;
			const commands = (app as any).commands.commands as Record<string, unknown>;
			return {
				enabled: plugins.enabledPlugins.has("rga-search") as boolean,
				commands: Object.keys(commands)
					.filter((id) => id.startsWith("rga-search:"))
					.sort(),
			};
		});
		expect(state.enabled).toBe(true);
		expect(state.commands).toEqual([`${ID}:search`, `${ID}:search-selection`, `${ID}:warm-cache`]);
	});

	it("finds text inside PDFs, with pages and reference notes, despite a damaged PDF", async function () {
		await search("covenant");
		await browser.waitUntil(async () => (await rows()).length === 8, { timeoutMsg: "two matching lines from each of two PDFs, four from a third" });
		const found = await rows();
		// rga searches files in parallel, so which document comes first varies.
		const sorted = [...found].sort((a, b) => (a.path + a.page).localeCompare(b.path + b.page));
		expect(sorted).toEqual([
			// No note links this one, so its file name is the title. Its page 4 has the word on
			// three consecutive lines, which rga reports as one block: each is its own row.
			{ title: "Line Breaks.pdf", page: "p. 2", match: "covenant", citekey: "", path: "archive/Line Breaks.pdf" },
			{ title: "Line Breaks.pdf", page: "p. 4", match: "Covenant", citekey: "", path: "archive/Line Breaks.pdf" },
			{ title: "Line Breaks.pdf", page: "p. 4", match: "covenant", citekey: "", path: "archive/Line Breaks.pdf" },
			{ title: "Line Breaks.pdf", page: "p. 4", match: "covenant", citekey: "", path: "archive/Line Breaks.pdf" },
			// An uppercase .PDF, linked from its note by a Markdown link with parentheses and a title.
			{ title: "Covenant Revisited", page: "p. 2", match: "covenant", citekey: "@jones1999", path: "archive/zotero/Jones (1999).PDF" },
			{ title: "Covenant Revisited", page: "p. 3", match: "covenant", citekey: "@jones1999", path: "archive/zotero/Jones (1999).PDF" },
			{ title: "Covenant and Creation", page: "p. 2", match: "covenant", citekey: "@smith2020", path: "archive/zotero/smith2020.pdf" },
			{ title: "Covenant and Creation", page: "p. 3", match: "covenant", citekey: "@smith2020", path: "archive/zotero/smith2020.pdf" },
		]);
		// Each document's lines stay together: a path never comes back after another one.
		const runs = found.map((r) => r.path).filter((p, i, all) => i === 0 || p !== all[i - 1]);
		expect(new Set(runs).size).toBe(runs.length);
		// The damaged PDF is reported, and doesn't hide the results.
		await browser.waitUntil(async () => (await browser.$$(".notice").length) > 0, { timeoutMsg: "a notice about the damaged file" });
		await expect(browser.$(".notice")).toHaveText(expect.stringContaining("damaged.pdf"));
	});

	it("opens the PDF at the matching page", async function () {
		// The highlighted row, which the pointer resting over the list can move.
		const selected = await browser.execute(() => {
			const el = document.querySelector(".suggestion-item.is-selected");
			return { path: el?.querySelector(".rga-search-path")?.textContent ?? "", page: (el?.querySelector(".rga-search-page")?.textContent ?? "").replace("p. ", "") };
		});
		expect(["2", "3"]).toContain(selected.page);
		await browser.keys("Enter");
		await browser.waitUntil(async () => (await activePath()) === selected.path, { timeoutMsg: "the PDF opens" });
		expect((await openedLinks()).at(-1)).toBe(`${selected.path}#page=${selected.page}`);
	});

	it("opens the reference note with Shift+Enter", async function () {
		await search("theology");
		await browser.waitUntil(async () => (await rows()).length === 2, { timeoutMsg: "one line from each PDF" });
		const first = (await rows())[0];
		const note = first.citekey === "@jones1999" ? "References/jones1999.md" : "References/smith2020.md";
		await browser.keys(["Shift", "Enter"]);
		await browser.waitUntil(async () => (await activePath()) === note, { timeoutMsg: "the reference note opens" });
	});

	it("finds a phrase that breaks across lines, and opens it at its page", async function () {
		await search("wasted an interview");
		await browser.waitUntil(async () => (await rows()).length === 1, { timeoutMsg: "the phrase, though pdftotext breaks it after 'an'" });
		expect(await rows()).toEqual([{ title: "Line Breaks.pdf", page: "p. 2", match: "wasted an interview", citekey: "", path: "archive/Line Breaks.pdf" }]);
		await browser.keys("Enter");
		await browser.waitUntil(async () => (await activePath()) === "archive/Line Breaks.pdf", { timeoutMsg: "the PDF opens" });
		expect((await openedLinks()).at(-1)).toBe("archive/Line Breaks.pdf#page=2");
	});

	it("says no matches with a count of unreadable files, and leaves notes to Obsidian's search", async function () {
		await search("leaves notes");
		// Report what the list last said, so a timeout explains itself.
		let seen = "";
		await browser
			.waitUntil(
				async () => {
					seen = await browser
						.$(".suggestion-empty")
						.getText()
						.catch(async () => `(no empty-state element; ${(await rows()).length} rows)`);
					return seen.startsWith("No matches.");
				},
				{ timeoutMsg: "no results from notes" },
			)
			.catch((e: Error) => {
				throw new Error(`${e.message}; the list last said: ${JSON.stringify(seen)}`);
			});
		await expect(browser.$(".suggestion-empty")).toHaveText("No matches. (1 file couldn't be read.)");
		await browser.keys("Escape");
	});
});
