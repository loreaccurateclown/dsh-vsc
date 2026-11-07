#!/usr/bin/env node
/**
 * Generate the runtime i18n tables from `i18n/maps/*.txt`.
 *
 * The maps are the single source of truth (`zh <=> en`, upstream's exact bytes on
 * the left). This script turns them into a checked-in TypeScript module so the
 * extension can translate at *load* time instead of rewriting built artifacts.
 *
 * Pair order matters: longest `zh` first, exactly like the retired build pass,
 * because a short fragment must not pre-empt the longer sentence containing it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mapsDir = join(root, "i18n", "maps");
const outFile = join(root, "src", "i18n", "tables.generated.ts");

function loadMap(name) {
  const pairs = [];
  for (const line of readFileSync(join(mapsDir, name), "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split(/\t+<=>\t/);
    if (parts.length >= 2) pairs.push([parts[0], parts.slice(1).join("\t<=>\t")]);
  }
  return pairs;
}

const longestFirst = (a, b) => b[0].length - a[0].length;

/** Panel/template tables: short UI fragments allowed (applied to HTML only). */
const ui = [...loadMap("core.txt"), ...loadMap("extra.txt")].sort(longestFirst);
/** Host tables: whole phrases only (the renderer's own strings live in the HTML).
 *  `templates.txt` holds messages with `{0}` placeholders, used via `tf()`. */
const host = [
  ...loadMap("extension.txt"),
  ...loadMap("extra.txt"),
  ...loadMap("extra2.txt"),
  ...loadMap("templates.txt"),
].sort(longestFirst);

const literal = (pairs) =>
  pairs.map(([zh, en]) => `  [${JSON.stringify(zh)}, ${JSON.stringify(en)}],`).join("\n");

const banner = `// GENERATED FILE — do not edit.
// Source: i18n/maps/*.txt  ·  Regenerate: npm run gen:i18n
//
// \`zh\` is upstream's original string (byte-exact), \`en\` this fork's translation.
// Entries may be sentence fragments; replacement runs longest-first and repeats
// until stable, so a fragment never pre-empts the sentence containing it.
`;

const body = `${banner}
export type I18nPair = readonly [zh: string, en: string];

/** Applied to webview templates (panel.html, settings.html, shell.html). */
export const UI_PAIRS: readonly I18nPair[] = [
${literal(ui)}
];

/** Applied to harness-facing host strings (extension.js). */
export const HOST_PAIRS: readonly I18nPair[] = [
${literal(host)}
];
`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, body);
console.log(`[i18n] wrote ${outFile}: ${ui.length} ui pairs, ${host.length} host pairs`);
