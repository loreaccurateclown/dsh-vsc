#!/usr/bin/env node
/**
 * Post-build English pass.
 *
 * The upstream panel is Chinese-only, so this fork keeps the zh→en tables in
 * `i18n/maps/` and rewrites the built artifacts after esbuild and before
 * `vsce package`. It never touches DSH: only the extension's own copies.
 *
 * Two disjoint tables on purpose — `core.txt` contains short UI fragments
 * (`文件 → File`) that would corrupt source identifiers if applied to the
 * bundled `extension.js`; the host table is whole phrases only.
 *
 * Anything not in the tables stays as upstream wrote it: on a newer upstream
 * this translates less rather than breaking.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mapsDir = join(root, "i18n", "maps");

function loadMap(name) {
  const file = join(mapsDir, name);
  if (!existsSync(file)) return [];
  const pairs = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const parts = line.split(/\t+<=>\t/);
    if (parts.length >= 2) pairs.push([parts[0], parts.slice(1).join("\t<=>\t")]);
  }
  return pairs;
}

const uiPairs = [...loadMap("core.txt"), ...loadMap("extra.txt")].sort((a, b) => b[0].length - a[0].length);
const hostPairs = [...loadMap("extension.txt"), ...loadMap("extra.txt"), ...loadMap("extra2.txt")].sort(
  (a, b) => b[0].length - a[0].length,
);

/** `extension.js` may carry CJK as \uXXXX escapes; decode so the tables match. */
function decodeCjkEscapes(source) {
  return source.replace(/\\u([0-9A-Fa-f]{4})/g, (match, hex) => {
    const cp = parseInt(hex, 16);
    const cjk = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef);
    return cjk ? String.fromCharCode(cp) : match;
  });
}

function apply(rel, pairs, decode) {
  const file = join(root, rel);
  if (!existsSync(file)) {
    console.warn(`[i18n] skip ${rel} (missing)`);
    return 0;
  }
  let source = readFileSync(file, "utf8");
  if (decode) source = decodeCjkEscapes(source);
  let hits = 0;
  for (const [zh, en] of pairs) {
    if (!source.includes(zh)) continue;
    hits += source.split(zh).length - 1;
    source = source.split(zh).join(en);
  }
  if (hits > 0) writeFileSync(file, source);
  const left = (source.match(/[\u4e00-\u9fff]/g) || []).length;
  console.log(`[i18n] ${rel}: ${hits} replaced, ${left} CJK left`);
  return hits;
}

let total = 0;
// Entries can chain (one replacement exposes text another entry matches), so
// repeat until a pass changes nothing. Bounded: each pass strictly shrinks the
// CJK surface, and a pathological map must not loop forever.
for (let pass = 1; pass <= 5; pass++) {
  let hits = 0;
  for (const rel of ["dist/media/native/panel.html", "dist/media/native/settings.html", "dist/media/shell.html", "package.json"]) {
    hits += apply(rel, uiPairs, false);
  }
  for (const rel of ["dist/extension.js"]) {
    hits += apply(rel, hostPairs, true);
  }
  total += hits;
  if (hits === 0) break;
}
console.log(`[i18n] done: ${total} replacements`);
