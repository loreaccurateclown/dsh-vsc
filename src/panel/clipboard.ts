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
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ClipboardImage =
  | { ok: true; mediaType: string; data: string }
  | { ok: false; error: string };

/** Result of putting something on the clipboard. */
export type ClipboardWrite = { ok: true } | { ok: false; error: string };

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Run one command, capturing binary stdout; resolves (never rejects).
 *  `stdinFile` feeds a file to the child's stdin (used by `wl-copy`). */
function run(cmd: string, args: string[], timeoutMs = 8000, stdinFile?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const child = spawn(cmd, args, { windowsHide: true });
    if (stdinFile) {
      try {
        child.stdin?.end(createReadStream(stdinFile));
      } catch {
        child.stdin?.end();
      }
    }
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
 * Read the clipboard image, then read it once more after a short pause.
 *
 * Apps that put a large image on the clipboard usually do it with *delayed
 * rendering*: the clipboard advertises a format and renders the bytes only when
 * a reader asks. That arrived here as "paste grabbed the previous image, try it
 * again" — the first `GetImage()` was answered by the previous owner's data.
 * Sampling twice (and a third time if the second was empty) returns what is
 * actually on the clipboard; it costs ~150 ms inside this process, with no extra
 * spawn, and paste is not latency-critical the way copy is.
 */
const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$img = [System.Windows.Forms.Clipboard]::GetImage()",
  "Start-Sleep -Milliseconds 150",
  "$later = [System.Windows.Forms.Clipboard]::GetImage()",
  "if ($null -eq $later) { Start-Sleep -Milliseconds 150; $later = [System.Windows.Forms.Clipboard]::GetImage() }",
  "if ($null -ne $later) { $img = $later }",
  "if ($null -eq $img) { exit 3 }",
  "$ms = New-Object System.IO.MemoryStream",
  "$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
  "[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
].join("; ");

/**
 * Windows clipboard writer, run as a script file because it is too long for a
 * command line and needs real control flow:
 *   exit 3 — the bytes could not be decoded by GDI+ or WIC
 *   exit 4 — the clipboard stayed locked by another process after retries
 * The retry loop is the fix for "copy it again and it works": `OpenClipboard`
 * fails whenever another app holds the clipboard, which is intermittent.
 */
const WINDOWS_SET_IMAGE_SCRIPT = [
  "param([string]$Path)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -Namespace Win32 -Name Clip -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetClipboardSequenceNumber();'",
  "function Load-Image([string]$p) {",
  "  try { return [System.Drawing.Image]::FromFile($p) } catch { }",
  "  # WIC decodes formats GDI+ refuses (WebP is a common DSH attachment).",
  "  Add-Type -AssemblyName PresentationCore",
  "  $uri = New-Object System.Uri($p)",
  "  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($uri, 'None', 'OnLoad')",
  "  $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder",
  "  $enc.Frames.Add($dec.Frames[0])",
  "  $ms = New-Object System.IO.MemoryStream",
  "  $enc.Save($ms)",
  "  $ms.Position = 0",
  "  return [System.Drawing.Image]::FromStream($ms)",
  "}",
  "$img = $null",
  "try { $img = Load-Image $Path } catch { exit 3 }",
  "if ($null -eq $img) { exit 3 }",
  // Windows bumps this on every clipboard update, so it answers "did our write
  // land?" in O(1) — no read-back, no hashing a 25 MB image. Content comparison
  // would be the only way to detect "same size, wrong image", and decoding a
  // 25 MB bitmap per copy is exactly the cost we are avoiding.
  "$before = [Win32.Clip]::GetClipboardSequenceNumber()",
  "$ok = $false",
  "for ($i = 0; $i -lt 20 -and -not $ok; $i++) {",
  "  try { [System.Windows.Forms.Clipboard]::SetImage($img); $ok = $true }",
  "  catch { Start-Sleep -Milliseconds 75 }",
  "}",
  "$img.Dispose()",
  "if (-not $ok) { exit 4 }",
  // exit 5 = the clipboard never changed, i.e. the previous image survived.
  "$after = [Win32.Clip]::GetClipboardSequenceNumber()",
  "if ($after -eq $before) { exit 5 }",
  "exit 0",
].join("\n");

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

/**
 * Put an image on the OS clipboard.
 *
 * `vscode.env.clipboard` writes text only, and a webview `copy` event carries
 * text too — which is why the native right-click "Copy" never copies image
 * bytes. Each platform gets the real thing through its own tooling; the bytes
 * go through a temp file because every one of these tools wants a file or a
 * pipe, not an argument (base64 of a render easily exceeds the command line).
 */
export async function writeClipboardImage(mediaType: string, base64: string): Promise<ClipboardWrite> {
  if (!base64) return { ok: false, error: "the image has no bytes" };
  const ext = mediaType === "image/jpeg" ? ".jpg" : mediaType === "image/webp" ? ".webp" : mediaType === "image/gif" ? ".gif" : ".png";
  const dir = mkdtempSync(join(tmpdir(), "dsh-vsc-copy-"));
  const file = join(dir, `image${ext}`);
  try {
    writeFileSync(file, Buffer.from(base64, "base64"));

    if (process.platform === "win32") {
      // Two intermittent failure modes, both of which look like "copy twice":
      //  * `OpenClipboard` fails while another process holds the clipboard
      //    (0x800401D0) — retried inside the script;
      //  * GDI+ cannot decode WebP, and DSH attachments are frequently WebP —
      //    transcoded through WIC when `Image::FromFile` throws.
      const scriptPath = join(dir, "set-image.ps1");
      writeFileSync(scriptPath, WINDOWS_SET_IMAGE_SCRIPT, "utf8");
      const result = await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        file,
      ]);
      if (result.code === 3) return { ok: false, error: "the image could not be decoded (unsupported format)" };
      if (result.code === 4) return { ok: false, error: "the clipboard stayed locked by another process" };
      if (result.code !== 0) {
        const detail = result.stderr.trim();
        return { ok: false, error: `could not write the clipboard${detail ? `: ${detail}` : " (PowerShell blocked?)"}` };
      }
      return { ok: true };
    }

    if (process.platform === "darwin") {
      const script = `set the clipboard to (read (POSIX file "${file.replace(/"/g, '\\"')}") as «class PNGf»)`;
      const result = await run("osascript", ["-e", script]);
      if (result.code !== 0) return { ok: false, error: `could not write the clipboard: ${result.stderr.trim()}` };
      return { ok: true };
    }

    if (process.platform === "linux") {
      const wayland = await run("wl-copy", ["--type", "image/png"], 8000, file);
      if (wayland.code === 0) return { ok: true };
      const x11 = await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-i", file]);
      if (x11.code === 0) return { ok: true };
      return { ok: false, error: "could not write the clipboard (wl-copy and xclip both failed)" };
    }

    return { ok: false, error: `copying images is not supported on ${process.platform}` };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp file is not worth reporting */
    }
  }
}
