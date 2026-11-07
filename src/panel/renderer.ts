/**
 * Grafted markdown renderer — the SAME engine the official DSH web GUI uses.
 *
 * The harness's web UI renders message text with micromark (+ GFM extensions);
 * this module is that same pipeline, bundled into the panel at build time
 * (esbuild injects it into panel.html; CSP is script-src 'unsafe-inline').
 * Markdown SEMANTICS (what is a heading / table / fence / bold…) come from
 * micromark, so our output matches the official renderer by construction.
 *
 * What stays ours is the webview-specific SPACING: the panel body is
 * `white-space: pre-wrap`, so block elements (headings/tables/pre) separate by
 * their own margins and must NOT be followed by a bare "\n" (it would double
 * into a visible blank row), while text paragraphs separate by "\n\n" (one
 * visible blank line). The official page has no pre-wrap bodies, so this
 * layer has no official counterpart to copy.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/** Top-level block elements micromark can emit (p is special-cased). */
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "pre", "table", "ul", "ol", "blockquote", "hr",
]);

/**
 * Collapse whitespace-only gaps BETWEEN tags everywhere except inside
 * <pre>…</pre> (code content is significant). micromark pretty-prints tables,
 * lists and blockquotes with newlines between tags; under the panel's pre-wrap
 * body those inter-tag newlines would render as visible blank rows. Code
 * blocks are masked out so their content keeps every newline.
 */
function minifyExceptPre(fragment: string): string {
  const pres: string[] = [];
  const masked = fragment.replace(/<pre[\s\S]*?<\/pre>/g, (m) => {
    pres.push(m);
    return `\u0000${pres.length - 1}\u0000`;
  });
  const collapsed = masked.replace(/>\s+</g, "><");
  return collapsed.replace(/\u0000(\d+)\u0000/g, (_, i) => pres[Number(i)]);
}

interface TopNode {
  kind: "p" | "block";
  html: string;
}

/**
 * Split a micromark fragment into its TOP-LEVEL block nodes. Nested block
 * elements (blockquote > p, blockquote > pre, …) stay inside their parent's
 * html — only depth-0 p/hN/pre/table/ul/ol/blockquote/hr become nodes.
 */
function splitTopLevel(html: string): TopNode[] {
  const nodes: TopNode[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let depth = 0;
  let cur = "";
  let curKind: "p" | "block" | null = null;
  let m: RegExpExecArray | null;
  let pos = 0;
  const flush = (): void => {
    if (curKind) {
      nodes.push({ kind: curKind, html: cur });
      cur = "";
      curKind = null;
    }
  };
  while ((m = tagRe.exec(html)) !== null) {
    const text = html.slice(pos, m.index);
    if (depth > 0 && curKind) cur += text;
    pos = tagRe.lastIndex;
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      if (tag === "hr") {
        // Void element: standalone top-level node when at depth 0.
        if (depth === 0) {
          flush();
          nodes.push({ kind: "block", html: m[0] });
        } else if (curKind) {
          cur += m[0];
        }
        continue;
      }
      if (!close) {
        if (depth === 0) {
          flush();
          curKind = tag === "p" ? "p" : "block";
        }
        depth++;
      } else {
        depth--;
        if (depth === 0) {
          cur += m[0];
          flush();
        }
      }
      if (depth > 0 && curKind) cur += m[0];
    } else if (depth > 0 && curKind) {
      cur += m[0];
    }
  }
  flush();
  return nodes;
}

/** Whether a markdown image URL names a file on this machine. The webview
 *  cannot load those (CSP blocks file:// / drive paths), so the panel asks the
 *  extension host for the bytes instead of showing a broken-image icon. */
function isLocalImagePath(url: string): boolean {
  const bare = url.replace(/^file:\/\//i, "");
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    /* keep the raw form */
  }
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/[^/])/.test(decoded);
}

/** Relative sentinel that survives micromark's URI sanitizer. A drive-letter
 *  or file: destination is replaced by `""` during compilation (measured:
 *  `![a](C:/x.png)` → `<img src="">`), which is exactly the broken-image row
 *  this whole path exists to remove. Rewriting the destination to a relative
 *  URL first keeps the path intact through parsing. */
const LOCAL_IMAGE_SENTINEL = "/dsh-local/";

/** Destinations micromark's sanitizer would drop: local paths *and* `data:` URIs
 *  (measured: `![a](data:image/png;base64,AAAA)` compiles to `<img src="">`). */
function needsSentinel(dest: string): boolean {
  return isLocalImagePath(dest) || /^data:/i.test(dest);
}

/** Rewrite local image destinations into the sentinel form before parsing. */
function encodeLocalImageTargets(md: string): string {
  return md.replace(/(!\[[^\]]*\]\()\s*<?([^)>\s]+)>?\s*(\))/g, (whole, head: string, dest: string, tail: string) =>
    needsSentinel(dest) ? `${head}${LOCAL_IMAGE_SENTINEL}${encodeURIComponent(dest)}${tail}` : whole
  );
}

/** Real remote destinations — the only ones the shell may be asked to open. */
function isRemoteUrl(url: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(url);
}

/** Inline `data:` images are the one payload no admission check guards: the
 *  bytes are already in the transcript, so a multi-megabyte one would land in
 *  the DOM before anything could object. The panel publishes the cap as
 *  `__DSH_MAX_DATA_URL__` (0 = disabled); over it, the frame degrades to text. */
function dataImage(url: string, rest: string): string {
  const cap = (globalThis as unknown as { __DSH_MAX_DATA_URL__?: number }).__DSH_MAX_DATA_URL__;
  if (typeof cap === "number" && cap > 0 && url.length > cap) {
    return `<span class="md-img-link" title="inline image exceeds the size cap">[图片]</span>`;
  }
  return `<img src="${url.replace(/"/g, "&quot;")}"${rest}>`;
}

/** Rewrite every markdown <img> in an HTML fragment: remote sources become
 *  links (CSP img-src blocks http), local files become `data-local-src`
 *  placeholders the panel hydrates through the host. Runs on the WHOLE
 *  fragment, not just top-level paragraphs — images inside list items or
 *  quotes would otherwise reach the webview as an unloadable src.
 *
 *  Anything that is not a remote URL counts as a file reference, absolute or
 *  relative: `terrain/newicon.png` is what the assistant actually writes, and
 *  routing that to `openExternal` fails in the shell with 0x2 on Windows. */
function rewriteImages(html: string): string {
  return html.replace(/<img\s+src="([^"]*)"([^>]*)>/g, (m, url: string, rest: string) => {
    if (url.startsWith("data:")) return dataImage(url, rest);
    if (url.startsWith(LOCAL_IMAGE_SENTINEL)) {
      let target = url.slice(LOCAL_IMAGE_SENTINEL.length);
      try {
        target = decodeURIComponent(target);
      } catch {
        /* keep the encoded form */
      }
      // A `data:` URI survives the CSP and needs no host round-trip.
      if (/^data:/i.test(target)) return dataImage(target, rest);
      return `<img class="md-img" data-local-src="${target.replace(/"/g, "&quot;")}"${rest}>`;
    }
    if (url === "") return m;
    if (isRemoteUrl(url)) return `<a class="md-img-link" href="${url}">[图片]</a>`;
    let target = url;
    try {
      target = decodeURIComponent(url);
    } catch {
      /* keep the encoded form */
    }
    return `<img class="md-img" data-local-src="${target.replace(/"/g, "&quot;")}"${rest}>`;
  });
}

/** Unwrap <p>…</p> into bare text (pre-wrap keeps the line structure) and
 *  rewrite markdown images the same way {@link rewriteImages} does. */
function pText(pHtml: string): string {
  return rewriteImages(pHtml.replace(/^<p>/, "").replace(/<\/p>$/, ""));
}

/** Map a block node onto the panel's class structure (same classes the old
 *  renderer emitted: md-hN / md-table / md-code + the block-copy button). */
function mapBlock(html: string): string {
  let out = html;
  out = out
    .replace(/<h([1-6])>/g, '<div class="md-h$1">')
    .replace(/<\/h([1-6])>/g, "</div>");
  out = out
    .replace(/<pre>/g, '<pre class="md-code">')
    .replace(/<\/pre>/g, '<button class="block-copy" title="复制代码">⧉ 复制</button></pre>');
  if (out.startsWith("<table")) out = '<div class="md-table">' + out + "</div>";
  return out;
}

/**
 * Render markdown message text for the panel.
 * Spacing rule (preserves the web markdown look):
 *  - block nodes: no trailing "\n" (their margins handle spacing);
 *  - text paragraph followed by text: "\n\n" (one visible blank line);
 *  - text paragraph followed by a block: one "\n";
 *  - no trailing newline at the very end.
 */
export function renderMd(text: string): string {
  const src = String(text ?? "");
  if (src.trim() === "") return "";
  const fragment = micromark(encodeLocalImageTargets(src), {
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
    allowDangerousHtml: false,
  });
  if (fragment.trim() === "") return "";
  const nodes = splitTopLevel(minifyExceptPre(fragment));
  let out = "";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind === "p") {
      out += pText(n.html);
      if (i < nodes.length - 1) {
        out += nodes[i + 1].kind === "p" ? "\n\n" : "\n";
      }
    } else {
      out += mapBlock(n.html);
    }
  }
  return rewriteImages(out).replace(/\n+$/u, "");
}

// Expose to the panel's inline scripts (they call DshMd.render).
(globalThis as unknown as { DshMd?: { render: (text: string) => string } }).DshMd = {
  render: renderMd,
};
