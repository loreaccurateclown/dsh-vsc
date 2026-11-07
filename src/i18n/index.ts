import * as vscode from "vscode";
import { fill, translateHost, type Lang } from "./core";

export type { Lang } from "./core";
export { translateHost, translateUi } from "./core";

/**
 * Language selection: `dshVsc.language` wins; otherwise follow VS Code's own
 * display language, so most users never touch the setting.
 */
let cached: Lang | undefined;

export function resolveLang(): Lang {
  if (cached) return cached;
  const configured = vscode.workspace.getConfiguration("dshVsc").get<string>("language", "auto");
  cached =
    configured === "en" || configured === "zh"
      ? configured
      : (vscode.env.language ?? "en").toLowerCase().startsWith("zh")
        ? "zh"
        : "en";
  return cached;
}

/** Drop the cache after the setting changes (the caller re-renders panels). */
export function resetLangCache(): void {
  cached = undefined;
}

/** Host-side lookup: `t("中文原文")` → English when the UI language is English. */
export function t(zh: string): string {
  return translateHost(zh, resolveLang());
}

/** Interpolated variant: `tf("已打开 {0} 个 diff。", n)`. The template carries
 *  `{n}` placeholders so Chinese and English can order the values differently. */
export function tf(template: string, ...args: readonly (string | number)[]): string {
  return fill(translateHost(template, resolveLang()), ...args);
}
