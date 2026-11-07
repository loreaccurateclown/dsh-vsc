import { HOST_PAIRS, UI_PAIRS, type I18nPair } from "./tables.generated";

/**
 * Runtime translation, replacing the retired post-build rewrite.
 *
 * The source tree keeps upstream's Chinese strings *byte-for-byte*, so Chinese
 * is the original and English is derived at load time. That keeps the fork
 * mergeable in both directions: no build step mutates upstream's artifacts and
 * an entry missing from the table simply renders in Chinese rather than breaking.
 */
export type Lang = "en" | "zh";

/** Entries may be fragments of a sentence, so a pass can expose text another
 *  entry matches. Bounded: each pass strictly shrinks the untranslated surface. */
const MAX_PASSES = 5;

/** Replace every `zh` key with its `en` value — longest key first, until stable. */
function applyPairs(text: string, pairs: readonly I18nPair[]): string {
  let out = text;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let next = out;
    for (const [zh, en] of pairs) {
      if (next.includes(zh)) next = next.split(zh).join(en);
    }
    if (next === out) break;
    out = next;
  }
  return out;
}

/** English when asked; the source string otherwise — `zh` *is* the original. */
export function translate(text: string, pairs: readonly I18nPair[], lang: Lang): string {
  return lang === "en" ? applyPairs(text, pairs) : text;
}

/** Webview templates (panel.html, settings.html, shell.html). */
export function translateUi(html: string, lang: Lang): string {
  return translate(html, UI_PAIRS, lang);
}

/** Host-side strings handed to VS Code (notifications, status bar, titles). */
export function translateHost(text: string, lang: Lang): string {
  return translate(text, HOST_PAIRS, lang);
}

/**
 * Substitute `{0}`, `{1}`, … so a translated template can reorder its values.
 * Chinese puts the count before the noun, English after; keeping the numbers as
 * placeholders lets each language own its own sentence order.
 */
export function fill(template: string, ...args: readonly (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}
