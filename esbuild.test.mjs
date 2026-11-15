// Bundles test/*.test.ts for node:test. The modules under test import only types
// from "obsidian"; the Obsidian layer itself is covered by the e2e tests in real Obsidian.
import esbuild from "esbuild";
import { readdirSync } from "node:fs";

const entries = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: "node",
  format: "esm",
  outdir: "test-dist",
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});
