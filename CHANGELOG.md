# Changelog

All notable changes to **dsh-vsc (DSH Bridge)**.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Togglable English UI, at runtime.** The zh→en tables in `i18n/maps/` are compiled by `scripts/gen-i18n-tables.mjs` into a module the extension loads, so webview templates are translated as they load and host strings go through `t()` — no build step rewrites upstream's artifacts any more. `dshVsc.language` = `auto` / `en` / `zh`; `zh` renders upstream's exact strings, and a missing entry falls back to Chinese instead of breaking. Messages with values use `tf("已打开 {0} 个 diff。", n)` so each language keeps its own word order.
- **Extension settings inside the panel.** The settings tab's General page now opens with an *Extension Settings* card (language, arrow keys, attachment cap, timestamps) wired to VS Code config. These rows work before the harness is reachable, because they are local to the extension.
- **Transcript timestamps** (`dshVsc.messageTimestamps`, default on): every user message shows `HH:MM ZONE`, each turn shows its start in the separator, and the completion strip shows when the round ended. All from the log's own event times, so history replays identically.
- **Composer arrow modes** (`dshVsc.promptArrowKeys`): `history` keeps the terminal behaviour (Up/Down walk previous prompts); `caret` gives the arrows back to the text.
- **Attachment size cap** (`dshVsc.maxAttachMB`, default 50, `0` disables): applied to path reads, clipboard images, dropped/pasted files and inline `data:` images.
- **Copy image** from the transcript: right-click → *Copy image* writes real bytes via PowerShell `SetImage`, JXA `NSPasteboard`, or `wl-copy`/`xclip`. VS Code's own Copy can only copy the text selection, so that menu is replaced on images.
- **Inline previews for `read_image`.** Tool results carry image blocks beside their text envelope; the panel now renders them as their own transcript row (fetched over `session.attachment`), so a preview is visible without expanding the tool card.
- **Panel watchdog.** The panel posts a `panelReady` handshake at load; if it never arrives the status bar flips to *panel did not load — restart VS Code* and a notification explains why, with a one-click **Quit VS Code**. When a shutdown marker shows this instance started soon after the previous one, the message says how soon — the known trigger, in numbers.
- Visible feedback for asynchronous clipboard work: `Copying image…` → `✓ Image copied` / `✗ Copy failed: <reason>`.

### Changed

- `npm run package` is now `gen:i18n` → `esbuild` → `vsce`; `scripts/apply-i18n.mjs` is retired.
- Injected `dsh-time-context` readings are folded into a single muted chip (hover for the full text, click to expand) instead of three lines per reading.
- Local link and image handling is whitelist-based: only `http(s)`/`mailto` reach the shell, everything else resolves as a file and opens in the editor.

### Fixed

- **Inline images that failed with Windows error `0x2`.** Relative paths (`renders/x.png`) were classified as links and handed to `ShellExecute`, which read `renders` as a URI scheme. They now resolve against the **session's DSH workspace first**, then the editor's folders, then the host cwd; a genuinely missing image degrades to a muted `[图片]` whose tooltip carries the path and reason.
- **Every tool card lost its result.** A `tool/result` message carries its blocks directly (no `tool-result` wrapper), so the result text — and `read_image`'s image — was discarded. Both shapes are accepted now, and parallel calls pair results by `callId` instead of "the most recent call".
- **Code-block copy buttons stayed Chinese.** The inlined renderer bundle was built with esbuild's default `ascii` charset, which escaped CJK to `\uXXXX`; literal translation could never match it. The bundle is emitted as UTF-8 now.
- **Copy image needed two attempts.** The writer retries when another process holds the clipboard, transcodes WebP (which GDI+ cannot decode) through WIC, and reports a definite outcome.
- **Pasting picked up the previous clipboard.** Windows reads now sample the clipboard twice ~150 ms apart, which defeats delayed rendering by the source application.
- A malformed i18n entry (`Copy中…` as a key) and a missing `复制代码` entry that rendered the tooltip as `Copy代码`.

### Known issues

- **`Could not register service worker: InvalidStateError`** can leave the panel blank for the lifetime of a VS Code process. A relaunch within ~15 s of quitting triggers it (measured: ~8–10 s failed, ~16 s worked). *Reload Window* does not clear it, and deferring the first paint or hiding the view does not prevent it — the first registration is attempted when VS Code creates the webview host, before extension code runs. Quit, wait ten or so seconds, reopen; the extension detects the dead panel and offers exactly that.

## [0.3.14] - 2026-10-29

- Fix: the composer status line at the bottom of the panel (context ring, rounds/steps, LLM & tool time, first-token, tok/s, token totals — and the running turn's `+N-M`) stopped appearing after the 0.2.1 migration. Two independent causes: the panel only ever read those three metrics out of a full session-list `state` message, so the line stayed empty unless a refresh happened to land after the values were already cached — an idle session never refreshes; and `tokenUsage` moved from flat counters to `{totals, last}`, so the token group was reading undefined fields. The host now pushes `sessionMetrics` the moment `tokenUsage` / `sessionStats` / `contextPressure` arrive (session follow snapshot or control stream), and the panel reads `totals` while still accepting the old flat shape.

## [0.3.13] - 2026-10-29

Copy path audited end to end; the 0.3.12 shape had a real defect that showed up as "the first Ctrl+C works, the rest do nothing".

- Fix: the `copy` handler cancelled the platform default on **every** copy while the host write was still in flight, so a copy had exactly one way to reach the clipboard and no way to report that it hadn't. The default is now left alone except when the selection actually carries an inlined image (the multi-MB `data:` URL is the only case where the platform write misbehaves), and the host write runs alongside it instead of replacing it. The two writing paths can no longer cancel each other out.
- Add: a second trigger for the transcript path — `keydown` Ctrl/Cmd+C — so a copy does not depend on the webview dispatching a `copy` event at all. Overlapping triggers for the same selection within 600 ms are deduped, so one keystroke is one write.
- Add: the host now **proves** each copy by reading the clipboard back (`vscode.env.clipboard.readText`, CRLF-normalized, one retry after 80 ms) and logs `copy N chars → verified` or the failure reason to the output channel. A mismatch is shown as an error row in the transcript instead of being swallowed: "剪贴板里不是刚复制的内容（要求 N 字符，回读 M 字符）".
- Fix: `copyText` was handled *after* the harness-connection gate, so a copy attempted while the harness was down turned into a "harness 未连接" error and wrote nothing. Clipboard work is local and now handled before that gate.
- Fix: the block copy button lives *inside* the `<pre>`, so `pre.textContent` ends with the button's own label. The old regex stripped only the literal `⧉ 复制`; after a click the label becomes `复制中…` / `✓ 已复制`, so clicking twice quickly copied the label into the clipboard. The button node is now removed from a clone before the text is read.
- Fix: tool-result copy buttons had both an inline handler and the delegated one, writing the clipboard twice per click; the inline handler is gone. Message-level and queue copy buttons now report success/failure like the block buttons do.
- Fix: `post()` swallows a `postMessage` throw, which is indistinguishable from a copy that silently did nothing. `requestCopy` calls the API directly and turns a throw into a visible error row.

## [0.3.12] - 2026-10-28

- Fix: copying from the panel no longer goes through the webview's clipboard at all. 0.3.10 tried to help by calling `clipboardData.setData("text/plain")` inside the `copy` event and cancelling the default; the write was still dropped, so both the box's `⧉ 复制` button and Ctrl+C left the clipboard unchanged with nothing to look at. The panel now posts the text to the extension host, which writes it with `vscode.env.clipboard.writeText` (Node side, outside the sandboxed webview) and answers `copyResult`; a copy button reports "✓ 已复制" only after that lands, and "✗ 复制失败" plus the reason when it does not. Ctrl+C keeps the platform path when the selection is inside the message input, where `window.getSelection()` is empty.

## [0.3.11] - 2026-10-27

- Fix: deleting a session no longer does nothing. The archive itself always reached the host (the registry holds 68 archived ids on this machine), but the sidebar never stopped drawing the row, because the archive set is read from the wrong place in both directions. Inbound, DSH 0.2.1 moved `archivedSessionIds` from the session rows to the `workspace/follow` **baseline** — and the bridge passed only `items` to its workspace handler, then read `archivedSessionIds` off that array, an always-`undefined` property; the standalone `{type:"archived"}` frame (which carries the set at the frame's top level, not under `value`) was dropped into a plain list refresh. Outbound, the archive RPC already answers with the complete durable set and we ignored it. So `archived` was an empty set forever, and every refresh re-added the row you just deleted. All three paths are now wired; the delete also passes `stopActivity: true` like the official delete button, so a session with a running turn/job/subagent archives instead of erroring `workspace/session-active`.
- Fix (0.3.10, superseded by 0.3.12): images inlined as multi-MB `data:` URLs made the default HTML-flavor clipboard write fail silently. Writing the plain-text flavor from the page did not survive either; the host now owns the clipboard.

## [0.3.6] - 2026-10-25 (released as 0.3.9)

- Fix: images the assistant links by local path (`![alt](D:\ComfyUI\output\x.png)`) now render in the sidebar instead of a broken-image icon with the alt text. Two layers were broken: the markdown compiler (micromark) **sanitizes any non-http destination to `src=""`** — measured, `![a](C:/x.png)` → `<img src="">`, so the path never even reached the panel — and a webview can never load `file://`/drive paths anyway. Destinations are now rewritten to a relative `/dsh-local/<encoded>` sentinel before parsing, turned back into `data-local-src` placeholders after, and the host reads the bytes into a `data:` URL — extension allow-listed (png/jpg/jpeg/webp/gif/bmp/avif), 16 MB cap, failure degrades to a labelled placeholder. Harness-stored attachments (user uploads) keep using `session.attachment`; this path is only for files the model referenced on disk.
- Fix: image layout. The sizing rule was keyed on `[data-local-src]`, an attribute hydration deletes once the bytes arrive — so every loaded image fell back to its natural size (a 1024px render filled the whole transcript and stacked on the next one). Images now carry a `md-img` class that survives hydration: `display:block` (two images can never share a line box), `max-width:100%`, `max-height:420px`, `object-fit:contain`, `height:auto`.

## [0.3.5] - 2026-10-25

- Fix: the panel could stay offline for the whole session when the harness was merely slow. Measured on a cold Windows boot: the auto-started `dsh web` printed its authenticated URL **after** the old 30 s readiness timeout, and the third such timeout disabled auto-retry *and stopped scheduling any further probe* — a live harness nobody ever looked at again. The readiness budget is now 90 s, and giving up spawning no longer stops the slow liveness poll (15 s), so a late harness still connects on its own.

## [0.3.4] - 2026-10-25

- Fix: the panel no longer spins forever when a harness we spawned outlives the window that spawned it. DSH 0.2.1 mints the launch token per process and the extension keeps it in memory only, so after a VS Code restart the surviving instance answered every probe with 401 — "alive" was enough to attach, and the attach had no credential. When the live instance is our own (pid record) and this window holds no token (`dshVsc.token` unset), it is now recycled and started fresh instead of being attached tokenless.

## [0.3.3] - 2026-10-24

- Fix: sidebar titles no longer turn into "session + id" after a host restart. `session/list` rows carry projection hints (`projections.values.title/tokenUsage/sessionStats/contextPressure`, read from the host's durable cache), but the sidebar read only the extension's in-memory store, which is filled by push frames — empty right after a restart. Rows are now seeded from their own hints before mapping; live events still supersede them. No host change and no data change: 149 of 169 stored logs already carry `session/title`, and the host's cache serves them either way.

## [0.3.2] - 2026-10-24

- Fix: history paging no longer guesses the log cut. It waits for the follow snapshot's cursor, and if the host still rejects the cut it retries with the cursor the host names in its own error (`session page through seq N is past cursor M`). Before, a `migration-required` session surfaced as a bare `gateway/bad-request`.
- Add: `scripts/normalize-session-logs.mjs` — dry-run by default, `--apply` keeps a `.bak` per file, and it strips the single member (`permission/preset.data.origin`) that makes DSH 0.2.x refuse a session written by 0.1.1-rc.1. Verified on four real conversations across four workspace buckets (26–112 events each) after normalization: all read back in full.
- Measured scope on a real library: 169 logs, **160 refused** before normalization, and **all 87 top-level conversations** are blocked only by that one member; the 82 subagent child logs carry a second blocker (`subagent/descriptor` v2) and stay unreadable — they are hidden sidebar rows anyway.

## [0.3.1] - 2026-10-24

- Fix: old (0.1.x) session logs now fail with an explicit Chinese explanation instead of a raw `gateway/internal` error. Measured on real logs: DSH 0.2.1 marks them `migration-required` and `dsh-session-format-v0-to-v1` **refuses** them (`permission/preset 0 data has unexpected member "origin"`), so those conversations cannot be opened after the upgrade — core behaviour, not a bridge defect.

## [0.3.0] - 2026-10-24

**DSH 0.2.1 line (Typert Remote).** Moves the bridge from the 0.1.x wire to 0.2.1-rc.3. **Not backward compatible with 0.1.x harnesses** — old dot-named endpoints answer `404`, with no compatibility alias.

### Changed — wire
- Endpoint table rewritten to slash form, with typed arguments under `payload.args` (`session/list` takes `_request`, underscore included); `session/prompt` now mints a `requestId`.
- `session.history` split into `session/page` (requires `throughSeq`, taken from the follow snapshot's cursor) + `session/projections`; `session/models` → `session/modelCatalog` (`default` / `routableProviders`); `agentPreset.list` → `agentPresets/list` (rows carry only id/order/isDefault, display copy comes from the bridge).
- Event transport rewritten: the fixed `/api/events.mux` is gone; everything is logical streams on one socket `/api/remote.mux` — `session/follow` (snapshot + durable events + raw assistant-stream chunks), `session/control` (projection baseline + deltas), `workspace/follow` (rows + archived set), `$events` (forwarded host events + answerable waterfalls).
- Approvals and questions: `/api/respond` → forwarded waterfalls answered through `$events/result` (`clientId` + `eventId` + outcome).
- Session list updates now ride forwarded `api-session/added|removed|status|activity` events; titles/usage/stats come from control projections instead of list rows.

### Added — auth (new in 0.2.1)
- `GET /connect?token=<launchToken>&interactions=answer` mints the signed API cookie that every `/api/*` call and the WS handshake must carry.
- The launcher captures the per-process launch token from `dsh web`'s stdout; a harness the extension did not start needs `dshVsc.token` from the user.

### Removed
- **Runtime overlay retired** (`src/harness/overlay/`, 4 deltas + 3 SHA-256 pins + `NODE_OPTIONS` injection): upstream now ships the windowless subprocess spawn and `STARTF_USESHOWWINDOW|SW_HIDE`, and `clientCount` vanished with `dsh-host-apiproxy`. The extension touches no official file.
- Reference-counted shutdown (`host.describe` → `clientCount`): shutdown now stops only the instance this extension spawned.

### Fixed
- Harness refusal copy keys on `session/attachment-invalid` (the 0.2.1 envelope, reason in `details.reason`) as well as the 0.1.x `attachment-error`.
- Settings writes omit `expectedRevision` when unknown — the 0.2.1 gateway rejects `null`.
- Permission select falls back to the three shipped presets, since 0.2.1's `permissions` projection carries only the current value.

### Notes
- 0.2.2–0.2.6 shipped without changelog entries; see `git log --oneline` for that span.

## [0.2.1] - 2026-08-30

- Docs: design-philosophy deep-dive and index pointer; install-from-Releases-first guidance; version placeholder for vsix filenames.
- Fix: activity-bar container id without a dot; untrusted-workspace support; sidebar focus command.

## [0.2.0] - 2026-08-30

- **Settings panel** + composer layout rework; model / effort split; agent-preset **mode picker**.
- Single-source wire schema (`src/harness/protocol.ts`); drop dead `agentPreset.select`.
- Grafted the official **micromark** markdown engine so GFM renders like the web GUI (headings, italics, strikethrough, tables, block margins).
- **Permission-preset** select (read-only / workspace-write / full-access) via permissions projection + `/permission` command; read `agentPreset.list` by official schema.
- In-panel **Ask card**, approval & question interaction cards, reasoning-effort switch.
- Runtime **in-memory patch loader** replaces disk-patch scripts (overlay).
- CI: auto-build and publish `.vsix` on version tags.

## [0.1.0] - 2026-08-23

- Initial release: DSH in the VS Code sidebar (embedded web GUI) + native bridge.
- Harness lifecycle: discover, reuse-or-auto-start, self-heal, reference-counted shutdown (`clientCount`).
- Native sidebar chat panel: streaming, session picker, queue/steer/edit/copy, task bar (todos projection), slash commands, `@` file-mention picker, per-turn timing, `+N-M` stats, collapsible tool actions.
- Editor bridge: **Ask DSH about selection** (structured context), **Review Agent Changes** (write/edit/str_replace_editor → native git diff).
- Overlay v1: client-count + window/console hiding, guarded by SHA-256 + canary anchors.
