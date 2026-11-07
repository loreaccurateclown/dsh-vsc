# DSH Bridge · DeepSeek Harness for VS Code

**Run [DeepSeek Harness](https://github.com/deepseek-ai/dsh) inside VS Code.** A native sidebar panel and a small editor bridge that talk to DSH as a **protocol client** — not an iframe of the web UI, not a second server, not a reimplementation of the agent.

![version](https://img.shields.io/badge/version-0.3.14-2ea44f)
![license](https://img.shields.io/badge/license-MIT-blue)
![vs code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

> **Fork of [zhibailu/dsh-vsc](https://github.com/zhibailu/dsh-vsc)** at 0.3.14, deliberately compatible with it: same protocol, same wire shapes, same "pure bridge" contract (see [docs/design.md](docs/design.md)). This fork adds an **English UI** and a few workflow fixes listed below. Everything else — approval cards, question cards, session modes, change review, harness lifecycle — is upstream's work, documented in [upstream's README](https://github.com/zhibailu/dsh-vsc#readme).

<p align="center"><img src="docs/screenshots/sidebar.png" width="290" alt="DSH sidebar" /></p>

---

## What this fork adds

**English UI, togglable.** Upstream ships Chinese-only. The fork keeps every upstream string byte-for-byte — Chinese stays the original — and adds a translation table in `i18n/maps/` (`zh ⇄ en`). `scripts/gen-i18n-tables.mjs` compiles it into a runtime module; webview templates are translated as they load and host strings go through `t()`, so no build step rewrites upstream's artifacts. Messages with values use `tf("已打开 {0} 个 diff。", n)` — placeholders rather than concatenation, so each language keeps its own word order. `dshVsc.language` selects `auto` (follow VS Code), `en`, or `zh`; `zh` renders upstream's exact strings, so nothing is re-translated in either direction, and a string missing from the table falls back to Chinese rather than breaking. Code comments stay in Chinese.

**Images, two ways.** Drag & drop onto the panel, and `Ctrl+V` in the composer. Drops arrive as either `DataTransfer` files or a VS Code `uri-list`; both are handled, in the capture phase, so the host's "open the dropped file" default never wins. Paste is harder: VS Code's clipboard API is text-only and a webview paste event never carries OS image bytes, so when the event has no image item the panel asks the host, which reads the platform clipboard through `src/panel/clipboard.ts`:

| Platform | Mechanism | Status |
|---|---|---|
| Windows | `powershell.exe -STA` + `Clipboard.GetImage()` | tested |
| macOS | JXA / `NSPasteboard`, `public.png` | untested |
| Linux | `wl-paste --type image/png`, else `xclip -t image/png -o` | untested |

The round-trip costs ~250–950 ms because it spawns a process — and on Windows it **samples the clipboard twice, ~150 ms apart**, because apps that put a large image there usually do it with *delayed rendering*: the first read can be answered by the previous owner's data, which is what "paste grabbed my old screenshot, try again" was. Copying goes the other way and is proven in-process (`GetImage` after `SetImage`), with a retry when another app holds the clipboard. If the clipboard holds no image or the tool is missing, the panel says so and attaches nothing.

**Inline images render.** An agent reply shows images two ways: as `{type:"image"}` blocks carrying a `sha256:…` attachment id, and as markdown like `![sheet](renders/29-soldier-red-size-sheet.png)`. Blocks are fetched over the harness's `session.attachment` RPC; markdown paths cannot load in a webview (CSP blocks `file:`), so the host reads the bytes and hands the panel a `data:` URL. Relative paths resolve against the **session's DSH workspace first** — that is the session's cwd, and it is not necessarily the folder open in VS Code — then the editor's folders, then the host cwd. Only `http(s)`/`mailto` destinations are ever treated as links, so a path can no longer reach the shell, where `Uri.parse("renders/x.png")` reads `renders` as a URI scheme and the launch dies with **0x2** ("cannot find the file"). `data:` URIs survive micromark's sanitizer, and an image that genuinely is not on disk degrades to a muted `[图片]` with the resolved path and the reason in its tooltip — never a dead link. **Right-click an image → Copy image** puts the real bytes on the OS clipboard: VS Code's Cut/Copy/Paste menu only copies the *text selection*, so its Copy can never copy an image, which is why that menu is replaced on images (`src/panel/clipboard.ts` writes via PowerShell `SetImage`, JXA `NSPasteboard`, or `wl-copy`/`xclip`).

**Local links open in the editor.** Upstream sent every markdown `href` to `vscode.env.openExternal`, so `C:\shots\a.png` parsed as URL scheme `c` and the shell failed with `0x2` ("cannot find the file"). The rule is now inverted to a whitelist: anything that is not `http(s)`/`mailto` — drive letter, UNC, `file:`, or a relative path — resolves like an image and opens in the editor after an existence check, and the host refuses to hand a non-URL to the shell even if a stray one arrives.

**Session picker grouped by workspace.** The web GUI groups sessions by **workspace**, treating anything outside every workspace as **Ungrouped**. Grouping by `cwd` gets this wrong, since every session has a `cwd`; the `workspace/follow` baseline already carries `WorkspaceView[]` with `sessionIds`, and the bridge now consumes it again. The picker renders one `<optgroup>` per workspace:

- groups are ordered by folder path, so `Programming` sits next to `…\StrategyGamev1`; rows keep recency order inside a group;
- a nested workspace is labelled by its path relative to the nearest ancestor workspace (`JavaScript\StrategyGamev1`), joined with the separator the path itself uses — `\` on Windows, `/` on POSIX — never an imposed one;
- labels are prefixed with a non-breaking space for depth, because Chromium collapses ordinary leading spaces in an `<optgroup label>`; casing comes from the real path segments, so `JavaScript` and `javascript` stay distinct on Linux;
- a small caption above the picker names the active session's workspace, so the folder is visible without opening the list; the full path is the tooltip;
- labels are derived from workspace rows at render time — no filesystem access, no watchers.

> **Workspace identity is the folder path** — a DSH rule this fork shows rather than works around. Moving a folder on disk does not relabel its sessions: the old workspace keeps them, and using the new location registers a second workspace. The picker reflects exactly what the harness reports.

**Composer.** The model picker sizes to its label (capped at 240 px, then ellipsis) instead of a fixed width, and the **reasoning-effort button is hidden** when the current model reports no efforts — no dead control with a placeholder label. Model switches also apply on the **first** click: the catalog keeps reporting the old `default` for ~400 ms after `session/selectModel`, so the host now posts the confirmed selection immediately and reconciles from the catalog after 500 ms. Up/Down can either walk the prompt history (terminal behaviour, default) or move the caret through a draft — `dshVsc.promptArrowKeys`.

**Timestamps and settings in the panel.** Every user message carries `HH:MM ZONE`, each turn shows its start and the completion strip its end, all from the log's own event times so history replays unchanged (`dshVsc.messageTimestamps`). The same strip reports the round's token cost — `↑12.1k ↓1.3k`, input (uncached plus cache reads) and output — measured from the `tokenUsage` projection at turn start and end; because that is a live projection rather than a durable event, rounds replayed from history carry the number only when it was captured live. The settings tab's General page opens with an **Extension Settings** card — language, arrow keys, attachment cap, timestamps — and those rows work before the harness is reachable, because they are local config.

**Panel watchdog.** The panel posts a `panelReady` handshake on load; if it never arrives, the status bar flips to *panel did not load — restart VS Code* and a notification names the cause and offers **Quit VS Code**. See the service-worker note below for why that is the only remedy.

**Token export.** `captureLaunchToken()` also writes `%TEMP%\dsh-vsc-token.json` (`{url, token, ts}`), so a second client of the same harness — such as a browser app window — can authenticate without hand-copying the per-process token. The file is absent when the extension merely attaches to a harness it did not start.

**Build.** `npm run package` runs `gen:i18n` → `esbuild` → `vsce package`.

---

## Install

VS Code `^1.90.0`, Node ≥18. DSH itself does not need to be installed by hand — the extension reuses a harness that is already running, and starts one only when nothing answers.

**From source** (this fork publishes no releases yet):

```bash
git clone https://github.com/loreaccurateclown/dsh-vsc.git
cd dsh-vsc
npm install
npm run package
code --install-extension dsh-vsc-*.vsix --force
```

**From a built package** you already have:

```bash
code --install-extension dsh-vsc-0.3.14.vsix --force
```

Either way, **Reload Window** afterwards, then click the **DSH** icon in the activity bar.

## Quick start

1. Reload the window — required after install.
2. Click the **DSH** icon in the left activity bar.
3. If nothing answers on `http://127.0.0.1:3080` the extension starts a harness silently; otherwise it reuses yours.
4. Send a message.

No API key is needed here: the key stays on the DSH side. The extension is a shared client and never touches it.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `dshVsc.url` | `http://127.0.0.1:3080` | Base URL of the harness. Also honors `DSH_WEB_URL`. |
| `dshVsc.autoStart` | `true` | Start `dsh web` when no harness answers at that URL. |
| `dshVsc.token` | `""` | Launch token, only needed for a harness you started yourself or one inside WSL. It changes every launch. |
| `dshVsc.language` | `auto` | `auto` / `en` / `zh` for this extension's own UI, including its notifications and errors. `zh` is upstream's original strings. Changing it rebuilds the panel. |
| `dshVsc.messageTimestamps` | `true` | Wall-clock times in the transcript: every user message, and each turn as "Round N · HH:MM". Reads the session log's own event times, so history replays identically. |
| `dshVsc.promptArrowKeys` | `history` | `history` = terminal Up/Down through previous prompts; `caret` = Up/Down move the cursor in the draft. |
| `dshVsc.maxAttachMB` | `50` | Size cap for anything read on the panel's behalf (path reads, clipboard images, drops). `0` disables it. |

## Notes

- **Context window.** DSH assumes 262,144 tokens for any model that doesn't declare a window, so a 1M model renders as 262K and the ring over-reports pressure. Declare it per model in the profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/`, or the Electron app's `profiles/desktop/`):

  ```yaml
  models:
    - id: deepseek-v4.1-flash
      contextWindow: 1048576
      maxTokens: 32768
  ```

  It applies per model on the next sample. Right after a model switch or a compaction the ring can still read high for one turn, because pressure is anchored to the last real request.
- **`Could not register service worker: InvalidStateError` — the panel stays blank.** A VS Code bug, not this extension, and the recovery is narrower than it looks. Quitting VS Code and **relaunching within ~15 s** can leave the new process unable to register a webview service worker at all; the failure then belongs to that process and survives for its lifetime. Measured on one machine: restarts ~8–10 s after quitting failed, ~16 s worked. **Reload Window does not fix it** — that restarts the extension host while the webview state lives in the app process — and neither does delaying the panel's first paint or hiding the view, both tried: the first registration is attempted when VS Code creates the webview host, before any extension code runs. The only remedy is to quit, wait ten or so seconds, and reopen.

  The extension cannot prevent it, so it makes it legible instead: the panel's script posts a `panelReady` handshake at load, and if it is silent for 1 s the status bar flips to *"panel did not load — restart VS Code"* and a notification explains the cause, offers **Quit VS Code** (one click, no second modal), and — when a shutdown marker shows this instance started soon after the previous one — says how soon, which is the trigger in numbers. The same detail is logged to **DSH Bridge**.
- **A second client gets 403** when the harness runs with `browserAccess:false`. Use the exported `%TEMP%\dsh-vsc-token.json`, or paste the token into `dshVsc.token`.
- **Never point two harnesses at one `DSH_HOME`.** Two `dsh web` processes sharing a history corrupt session logs (`corrupt session log: seq gap`). The extension never starts a second server on an existing history.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run gen:i18n    # i18n/maps/*.txt → src/i18n/tables.generated.ts
npm run build       # esbuild → dist/extension.js + dist/media
npm run package     # gen tables + build + vsix
```

F5 debug via [`.vscode/launch.json`](.vscode/launch.json). Docs: [design](docs/design.md), [source map](src/README.md), [changelog](CHANGELOG.md), [agent notes](AGENTS.md).

## License

MIT © 2026 zhibailu — see [LICENSE](LICENSE). Fork modifications by [loreaccurateclown](https://github.com/loreaccurateclown).
