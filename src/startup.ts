/**
 * Shutdown marker — diagnostics only.
 *
 * Measured: quitting VS Code and relaunching within ~15 s can leave the new
 * process unable to register a webview service worker at all, and that state is
 * fixed for the process's lifetime. Deferring the panel's first paint (or hiding
 * the view until later) does not help: the damage happens at launch, so the only
 * remedy is to start the editor later — which an extension cannot do.
 *
 * So this file exists to *explain* the failure, not to prevent it: the next
 * instance can read how soon it started after the previous one quit and say so
 * in the recovery message.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";

interface ShutdownMarker {
  /** When the previous instance's extension host deactivated. */
  ts: number;
  /** `vscode.env.sessionId` of that instance — same id means a window reload. */
  sessionId: string;
  /** Parent pid of that extension host — stable across a window reload. */
  ppid: number;
}

const MARKER = "last-shutdown.json";

function markerPath(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, MARKER);
}

export function writeShutdownMarker(context: vscode.ExtensionContext): void {
  try {
    const file = markerPath(context);
    mkdirSync(dirname(file), { recursive: true });
    const marker: ShutdownMarker = { ts: Date.now(), sessionId: vscode.env.sessionId, ppid: process.ppid };
    writeFileSync(file, JSON.stringify(marker), "utf8");
  } catch {
    /* a missing marker only costs an explanation */
  }
}

/**
 * How long ago the previous instance quit, in ms — or `undefined` when there is
 * nothing usable to report (first run, unclean exit, or a window reload, where
 * the gap would describe the reload rather than an app restart).
 */
export function shutdownGapMs(context: vscode.ExtensionContext): number | undefined {
  const file = markerPath(context);
  if (!existsSync(file)) return undefined;
  let marker: ShutdownMarker;
  try {
    marker = JSON.parse(readFileSync(file, "utf8")) as ShutdownMarker;
  } catch {
    return undefined;
  }
  // Same window session AND same host parent → a reload of this app, not a
  // restart; the gap would be meaningless.
  if (marker.sessionId === vscode.env.sessionId && marker.ppid === process.ppid) {
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    return undefined;
  }
  const gap = Date.now() - marker.ts;
  return Number.isFinite(gap) && gap >= 0 ? gap : undefined;
}
