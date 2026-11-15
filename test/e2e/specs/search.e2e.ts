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

describe("RGA Search", function () {
	before(async function () {
		await obsidianPage.resetVault();
		await recordOpenedLinks();
	});

	beforeEach(async function () {
		// Close any search box a failed test left open.
		await browser.executeObsidian(({ app }) => (app as any).workspace.containerEl.ownerDocument.querySelectorAll(".modal-close-button").forEach((b: HTMLElement) => b.click()));
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

	it("finds text inside a PDF, with its page and reference note", async function () {
		await search("covenant");
		await browser.waitUntil(async () => (await browser.$$(".rga-search-result").length) === 2, { timeoutMsg: "two matching lines from the PDF" });
		const results = browser.$$(".rga-search-result");
		await expect(results[0].$(".rga-search-title")).toHaveText("Covenant and Creation");
		await expect(results[0].$(".rga-search-page")).toHaveText("p. 2");
		await expect(results[0].$(".rga-search-match")).toHaveText("covenant");
		await expect(results[0].$(".rga-search-citekey")).toHaveText("@smith2020");
		await expect(results[1].$(".rga-search-page")).toHaveText("p. 3");
	});

	it("opens the PDF at the matching page", async function () {
		await browser.keys("Enter");
		await browser.waitUntil(async () => (await activePath()) === "archive/zotero/smith2020.pdf", { timeoutMsg: "the PDF opens" });
		expect((await openedLinks()).at(-1)).toBe("archive/zotero/smith2020.pdf#page=2");
	});

	it("opens the reference note with Shift+Enter", async function () {
		await search("theology");
		await browser.$(".rga-search-result").waitForDisplayed();
		await browser.keys(["Shift", "Enter"]);
		await browser.waitUntil(async () => (await activePath()) === "References/smith2020.md", { timeoutMsg: "the reference note opens" });
	});

	it("leaves Markdown notes to Obsidian's own search", async function () {
		await search("leaves notes");
		await browser.waitUntil(async () => (await browser.$(".suggestion-empty").getText()) === "No matches.", { timeoutMsg: "no results from notes" });
		await browser.keys("Escape");
	});
});
