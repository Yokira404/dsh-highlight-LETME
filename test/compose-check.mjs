/**
 * Loader composition check: parse the bundle patch exactly like the desktop
 * profile boot does (loadOverlayPatches + composeEntries from dsh-app-boot)
 * and verify the composed rows contain the letme-annotator entry.
 *
 * Run with:  node test/compose-check.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Resolve dsh packages through the active profile's dependency graph,
// exactly like the desktop loader would.
const requireFromProfile = createRequire(
	"C:/Users/Yokira/.dsh/profiles/desktop/package.json"
);

const { loadOverlayPatches, composeEntries } = requireFromProfile("@deepseek-ai/dsh-app-boot");

const patchPath = join(root, "cordis.patch.yml");
const patches = loadOverlayPatches("dsh-plugin-letme-annotator", patchPath);
const rows = composeEntries([patches]);

const row = rows.find((candidate) => candidate.id === "letme-annotator");
if (row === undefined) {
	console.error("FAIL - composed rows do not contain id 'letme-annotator'");
	console.error(JSON.stringify(rows, null, 2));
	process.exit(1);
}
if (row.name !== "dsh-plugin-letme-annotator") {
	console.error(`FAIL - row name is '${row.name}', expected 'dsh-plugin-letme-annotator'`);
	process.exit(1);
}
if (row.disabled === true) {
	console.error("FAIL - row must not be disabled");
	process.exit(1);
}

// Mirror the desktop bundle-layer check: package.json must declare dsh.bundle.patch.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = pkg.dsh?.bundle?.patch;
if (typeof declared !== "string" || declared.length === 0) {
	console.error("FAIL - package.json declares no dsh.bundle.patch");
	process.exit(1);
}

console.log(`ok - composed row: id=${row.id} name=${row.name}`);
console.log(`ok - bundle patch declared: ${declared}`);
console.log("All composition checks passed.");
