import * as fs from "node:fs";

/** Only the tail is inspected: supervisors append, so the newest token is last. */
const MAX_TAIL_BYTES = 256 * 1024;

/**
 * Read the newest launch token from a file owned by whoever runs the harness.
 *
 * Two shapes are accepted, both written by real launchers:
 *
 * - a `dsh web` launch line, e.g. `dsh web: http://127.0.0.1:3080/?token=…`
 *   (what a supervisor script redirects to a log);
 * - a JSON token export, e.g. `{ "token": "…", "url": "…" }` (what
 *   `%TEMP%\dsh-vsc-token.json` holds).
 *
 * The token rotates with every harness process, so callers must call this per
 * connection attempt rather than caching the result.
 *
 * @param file Path to the file. Empty string disables the lookup.
 * @returns the newest token found, or `undefined` when absent/unreadable.
 */
export function readTokenFromFile(file: string): string | undefined {
  if (!file) return undefined;

  let text: string;
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return undefined;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(fd, buffer, 0, length, start);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }

  const fromLaunchLine = [...text.matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)];
  if (fromLaunchLine.length > 0) return fromLaunchLine[fromLaunchLine.length - 1][1];

  const fromJson = [...text.matchAll(/"token"\s*:\s*"([A-Za-z0-9_-]+)"/g)];
  if (fromJson.length > 0) return fromJson[fromJson.length - 1][1];

  return undefined;
}
