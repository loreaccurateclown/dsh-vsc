# Developer notes — findings worth not rediscovering

Hard-won facts about DSH, VS Code webviews, and this fork. Each one cost real
debugging time; most look like bugs somewhere else until you measure them.
Not user documentation (see `README.md` for that).

---

## 1. Per-turn token counts are not obtainable from a protocol client

**Symptom.** The status bar shows session token totals, but a round's completion
strip cannot show what that round cost.

**What we measured**, against a live harness on 0.2.1:

- Token usage is **not in the session log.** No event type carries
  `uncachedInputTokens`, `cacheReadTokens` or `outputTokens` — grep the `.zstd`
  logs by event type and the needle is absent. So history replay can never show
  per-round numbers, whatever the UI does.
- It exists only as the `tokenUsage` **projection**, delivered on
  `session/control` and shipped to the panel as `sessionMetrics.usage`.
- That projection has **no `last` / per-step buckets** in practice: a diagnostic
  printing the step key logged `steps none` on every turn. Shapes vary — nested
  under `totals`, flat, or unit-wrapped `{ver,seq,val}`; a reader must accept all
  three (the status line's `u.totals || u` is why it works).
- **Cumulative `totals` advance at turn boundaries, not during a turn.** Measured:
  `base` (snapshot at turn start) equalled `now` (totals at turn end) on every
  turn, so `end − start` is structurally `0`.

**What was tried, and why each failed.**

| Approach | Outcome |
|---|---|
| Delta of totals at turn end | Always 0 — nothing is published yet |
| Fill on every metrics frame, overwriting | Never sees a change inside the turn |
| Sum `last` per-step buckets across the turn | `last` does not exist (`steps none`) |
| Attribute the jump to the *previous* turn at each `turn/start` | Only source that can work, but the chip then lags one round and the newest round is always blank |

**Conclusion.** A round's cost is only knowable once the harness publishes a new
boundary, and a client cannot back-date it. The feature was removed rather than
shipped as something that silently shows nothing. Doing this properly needs the
harness to record usage as a durable session event (or expose per-step usage);
no client-side change can substitute.

---

## 2. `Could not register service worker: InvalidStateError` — the panel stays blank

**Trigger (measured).** Quit VS Code and relaunch **within ~15 s**. Restarts at
~8–10 s after quitting failed; ~16 s worked. Happens only on cold start, and the
next start after a failure always works.

**Mechanism.** VS Code registers a service worker per webview origin. If the
attempt fails at launch, that state belongs to the **app process** and is sticky
for its lifetime. `Reload Window` restarts the extension host but reuses the
process → no help. Only a full quit clears it.

**What does NOT help** (each was implemented and tested):

- Delaying the first `webview.html` assignment (2.5 s, then 16 s after the
  previous `deactivate`). The first registration is attempted when VS Code
  **creates the webview host**, before any extension code runs — the delay merely
  produced a second failed attempt (two error toasts a few seconds apart).
- Hiding the view behind a `when` context key until the settle window elapsed.
  Same result: creating it later inside an already-poisoned process still fails.

**What the fork does instead** (all that survived):

- Panel posts `panelReady` at script start; a 1 s silence flips the status bar to
  *panel did not load — restart VS Code* and shows one notification with a
  **Quit VS Code** button. Nothing reloads or quits automatically.
- A shutdown marker (`shutdownGapMs` in `src/startup.ts`) records when the
  previous instance deactivated, so the message can say *"this VS Code started
  about 8 s after the previous one quit"* — the trigger in numbers. Suppressed
  for window reloads (same `sessionId` **and** same `process.ppid`).

---

## 3. Tool results carry their blocks directly

A `tool/result` message is:

```json
{ "role": "tool", "toolCallId": "call_…",
  "content": [{ "type": "text" }, { "type": "image", "attachment": {…} }],
  "isError": false }
```

There is **no `{type:"tool-result"}` wrapper** in that message's `content`. Code
that searched for the wrapper found nothing and silently dropped every tool
result — text and images alike. `toolResultBlock()` accepts both shapes.

Also: results can arrive out of order when a turn runs tools in parallel.
Pairing by "the most recent call" silently discarded them; pair by `callId`.

`read_image` returns `[text, image]`; the image is an attachment
(`sha256:…` id) fetched over the `session.attachment` RPC. It is rendered as its
own transcript row so a collapsed *Actions* group cannot hide the preview.

---

## 4. The renderer freezes finished turns

Every item at or before the last `turn-end` keeps its DOM and is **never
re-synced** (deliberate: no re-render storms, no scroll jumps, past turns are
immutable). Consequence: mutating an `item` after it has been rendered is
invisible — the change never reaches the screen. Post-render updates must patch
the node directly (`messagesEl.querySelector('[data-key="<id>"]')`).

This is what made the token chip look "not wired up" even after the value was
computed correctly.

---

## 5. Clipboard specifics (Windows)

- **Reading** must sample twice, ~150 ms apart. Screenshot tools and other apps
  use *delayed rendering*: a single `GetImage()` can be answered by the previous
  owner's data — "paste grabbed my old image, try again".
- **Writing**: `Clipboard.SetImage` retries 20×75 ms because `OpenClipboard`
  fails while another app holds the clipboard (that is the classic "copy twice
  and it works"). WebP must be transcoded through WIC first; GDI+ cannot decode it.
- **Verifying a write**: compare `GetClipboardSequenceNumber()` before/after.
  O(1), no read-back, no decoding a 25 MB image. Checking merely "is there an
  image?" passes when the write failed and the *previous* image survived — which
  then gets pasted.
- **`navigator.clipboard.write()` works in VS Code webviews.** So VS Code's own
  Cut/Copy/Paste menu can copy images, provided the image is focused on
  `contextmenu` and the `copy` event is intercepted. The host-side PowerShell
  writer stays as a fallback (rejections are logged, not swallowed).

---

## 6. i18n: the renderer bundle must be UTF-8

`injectRenderer()` inlines the markdown renderer into `panel.html`. Built with
esbuild's default `charset: "ascii"`, every CJK string became `\uXXXX` — so the
runtime literal-translation table could never match it, and every code-block
copy button stayed Chinese while the rest of the UI was English. Set
`charset: "utf8"` for that build (both the one-shot and the watch path).

Translation itself: `i18n/maps/*.txt` are `zh ⇄ en` pairs compiled by
`scripts/gen-i18n-tables.mjs` into a module. Templates are translated at load
(`translateUi`), host strings through `t()` / `tf()` (placeholders, so each
language keeps its own word order). Missing entries fall back to Chinese rather
than breaking. Never add a map line without the `\t<=>\t` separator — the loader
skips it silently.

---

## 7. Links and images: the `0x2` trap

`Uri.parse("renders/x.png")` treats `renders` as a URL scheme, and
`ShellExecute` fails with `0x2` ("cannot find the file"). The rule is a
whitelist: only `http(s)`/`mailto` reach the shell; everything else resolves as a
file. Relative paths resolve against the **session's DSH workspace first** — that
is the session's cwd, and it is not necessarily the folder open in VS Code — then
the editor's folders, then the host cwd. `data:` URIs need the sentinel rewrite
because micromark's sanitizer strips them at parse time.

---

## 8. Settings plumbing, if you add another knob

1. `package.json` → `contributes.configuration` (and the README table).
2. Host getter in `NativePanelProvider`.
3. Ship it in **both** the `state` frame and the targeted `config` push — the
   latter exists because a value consumed in a keydown handler must not wait for
   a full state refresh.
4. Panel: assign in `case "state"` **and** `case "config"`; call
   `scheduleRender()` for values that affect already-rendered items.
5. The Extension Settings card in `settings.html` writes through
   `setExtensionSetting` (`postExtensionSettings` on `settingsReady`); these rows
   are handled before the harness-connection gate, so they work while DSH is down.
