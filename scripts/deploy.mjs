// Copies the built plugin into a vault for trying it out:
//   npm run build && npm run deploy -- "/path/to/vault"
// or set OBSIDIAN_VAULT. Then reload Obsidian (or toggle the plugin) to pick it up.
// Only main.js, manifest.json and styles.css are written; the plugin's data.json is kept.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const vaultArg = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vaultArg) {
	console.error('Usage: npm run deploy -- "/path/to/vault"   (or set OBSIDIAN_VAULT)');
	process.exit(1);
}
const vault = resolve(vaultArg);
if (!existsSync(join(vault, ".obsidian")) || !statSync(join(vault, ".obsidian")).isDirectory()) {
	console.error(`${vault} isn't an Obsidian vault (no .obsidian folder).`);
	process.exit(1);
}
if (!existsSync("main.js")) {
	console.error("main.js is missing: run `npm run build` first.");
	process.exit(1);
}

const { id, version } = JSON.parse(readFileSync("manifest.json", "utf8"));
const dest = join(vault, ".obsidian", "plugins", id);
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(dest, f));
console.log(`Deployed ${id} ${version} to ${dest}. Reload Obsidian, then enable it under Community plugins.`);
