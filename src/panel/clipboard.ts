/**
 * Clipboard image reading.
 *
 * VS Code exposes only text on `vscode.env.clipboard`, and a webview paste
 * event normally carries no OS image item, so an image can only be obtained by
 * asking the platform's own clipboard tooling. Every branch below returns a PNG
 * as base64 so the panel can treat all platforms identically.
 *
 *   win32  — PowerShell + System.Windows.Forms (needs -STA)  [tested]
 *   darwin — JXA / NSPasteboard, PNG representations only    [untested]
 *   linux  — wl-paste, falling back to xclip                 [untested]
 *
 * The failures are returned as data, not thrown: the panel shows them and drag
 * & drop keeps working, so an unavailable clipboard never blocks attaching.
 */
import { spawn } from "node:child_process";

export type ClipboardImage =
  | { ok: true; mediaType: string; data: string }
  | { ok: false; error: string };

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Run one command, capturing binary stdout; resolves (never rejects). */
function run(cmd: string, args: string[], timeoutMs = 8000): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn(cmd, args, { windowsHide: true });
    const finish = (code: number, stderr?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out),
        stderr: stderr ?? Buffer.concat(err).toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(-1, "timeout");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => finish(-2, String(error)));
    child.on("close", (code) => finish(code ?? -3));
  });
}

/**
 * GetImage() returns a Bitmap; saving it as PNG keeps the payload small and
 * gives the panel a media type it already knows how to render.
 */
const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$img = [System.Windows.Forms.Clipboard]::GetImage()",
  "if ($null -eq $img) { exit 3 }",
  "$ms = New-Object System.IO.MemoryStream",
  "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
  "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
].join("; ");

/** `public.png` is the only representation JXA can hand back without conversion. */
const DARWIN_SCRIPT = [
  "ObjC.import('AppKit')",
  "var pb = $.NSPasteboard.generalPasteboard",
  "var d = pb.dataForType('public.png')",
  "d ? ObjC.unwrap(d.base64EncodedStringWithOptions(0)) : ''",
].join("; ");

export async function readClipboardImage(): Promise<ClipboardImage> {
  if (process.platform === "win32") {
    const result = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-Command",
      WINDOWS_SCRIPT,
    ]);
    if (result.code === 3) return { ok: false, error: "the clipboard has no image" };
    if (result.code !== 0) {
      const detail = result.stderr.trim();
      return { ok: false, error: `could not read the clipboard${detail ? `: ${detail}` : " (PowerShell blocked?)"}` };
    }
    const data = result.stdout.toString("ascii").trim();
    if (!data) return { ok: false, error: "the clipboard has no image" };
    return { ok: true, mediaType: "image/png", data };
  }

  if (process.platform === "darwin") {
    const result = await run("osascript", ["-l", "JavaScript", "-e", DARWIN_SCRIPT]);
    const data = result.stdout.toString("utf8").trim();
    if (result.code !== 0 || !data) {
      return { ok: false, error: "the clipboard has no PNG image (macOS reads public.png only)" };
    }
    return { ok: true, mediaType: "image/png", data };
  }

  if (process.platform === "linux") {
    const wayland = await run("wl-paste", ["--no-newline", "--type", "image/png"]);
    if (wayland.code === 0 && wayland.stdout.length > 0) {
      return { ok: true, mediaType: "image/png", data: wayland.stdout.toString("base64") };
    }
    const x11 = await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
    if (x11.code === 0 && x11.stdout.length > 0) {
      return { ok: true, mediaType: "image/png", data: x11.stdout.toString("base64") };
    }
    return { ok: false, error: "the clipboard has no image (wl-paste and xclip found none)" };
  }

  return { ok: false, error: `clipboard image reading is not supported on ${process.platform}` };
}
