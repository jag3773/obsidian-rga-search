// End-to-end tests in real Obsidian (desktop only: RGA Search is a desktop plugin).
// See test/e2e/README.md. Run with `npm run test:e2e` after `npm run build`.
// rga and pdftotext must be installed where the plugin can find them.
//
// Environment:
//   OBSIDIAN_VERSIONS   app/installer pairs, default "earliest/earliest latest/latest"
//                       ("earliest" is minAppVersion in manifest.json)
//   WDIO_MAX_INSTANCES  parallel Obsidian instances, default 2
import * as path from "node:path";
import { env } from "node:process";
import { parseObsidianVersions } from "wdio-obsidian-service";

const cacheDir = path.resolve(".obsidian-cache");
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "earliest/earliest latest/latest", { cacheDir });
if (env.CI) {
	// The workflow uses this line as the key for its .obsidian-cache cache.
	console.log("obsidian-cache-key:", JSON.stringify(versions));
}

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/e2e/specs/**/*.e2e.ts"],
	maxInstances: Number(env.WDIO_MAX_INSTANCES || 2),
	capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
		browserName: "obsidian",
		"wdio:obsidianOptions": { appVersion, installerVersion, plugins: ["."], vault: "test/e2e/vaults/library" },
	})),
	services: ["obsidian"],
	reporters: ["obsidian"],
	mochaOpts: { ui: "bdd", timeout: 90 * 1000 },
	waitforInterval: 250,
	waitforTimeout: 15 * 1000,
	logLevel: "warn",
	cacheDir,
	injectGlobals: false,
};
