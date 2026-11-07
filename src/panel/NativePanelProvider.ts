import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { HarnessClient, RpcErrorResult } from "../harness/client";
import type { PromptContentPart, QueueAction } from "../harness/protocol";
import type { AnswerableEvent, HarnessEventStream } from "../events/eventStream";
import type { HostMessage, PanelEvent, PanelSession, TodoItem, ToolLineDiff, WebviewMessage } from "./protocol";
import type { WorkspaceView } from "../harness/protocol";
import { countMetaDiff, countToolArgsDiff } from "../editor/diffCount";
import { INTENT_CHOICES, sendAsk } from "../editor/askSelection";
import { readClipboardImage, writeClipboardImage } from "./clipboard";
import { resolveLang, t, tf, translateUi } from "../i18n";

/**
 * Display copy for the four shipped agent presets — the official zh text from
 * the harness's config agent-presets preset.yml files (name + description),
 * the same strings the DSH web GUI's preset picker shows for system presets.
 * Used as a fallback so the ＋ mode dropdown renders official copy even when
 * the roster entry carries no name/description; live roster wins when present.
 */
const OFFICIAL_PRESET_COPY: Record<string, { name: string; description: string }> = {
  standard: {
    name: t("标准模式"),
    description: t("功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。"),
  },
  code: {
    name: t("PTC 模式"),
    description: t("具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。"),
  },
  minimal: {
    name: t("极简模式"),
    description: t("仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。"),
  },
  cordis: {
    name: t("创造模式"),
    description: t("用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。"),
  },
};

/**
 * Chinese copy for the harness's attachment-admission refusals
 * (dsh-attachment `ATTACHMENT_REASONS`). On the wire these arrive as
 * `attachment-error` with `details.reason`; their English text is what reached
 * users as a bare red warning that looked like a defect in this extension.
 */
/**
 * Chinese copy for the harness's attachment-admission refusals
 * (dsh-attachment `ATTACHMENT_REASONS`). On the wire these arrive as
 * `attachment-error` with `details.reason`; their English text is what reached
 * users as a bare red warning that looked like a defect in this extension.
 *
 * WORDS ONLY: the request still travels to the harness and the harness still
 * refuses it, so core keeps behaving — and logging — exactly as before. No
 * limit is duplicated here: quoting this deployment's numbers would be the
 * bridge re-modelling a core fact that the deployment config owns.
 */
const ATTACHMENT_REASON_COPY: Record<string, string> = {  IMAGE_DIMENSION_TOO_LARGE: t("图片单边像素超过本体上限，请先裁剪或缩小后再发。"),
  IMAGE_TOO_MANY_PIXELS: t("图片总像素超过本体上限，请先缩小后再发。"),
  IMAGE_TOO_LARGE: t("单张图片体积超过本体上限，请压缩后再发。"),
  TOO_MANY_IMAGES: t("单条消息的图片数量超过本体上限，请分批发送。"),
  IMAGES_TOO_LARGE: t("单条消息的图片总体积超过本体上限，请分批发送。"),
  UNSUPPORTED_IMAGE_TYPE: t("本部署不接受这种图片格式。"),
  IMAGE_TYPE_MISMATCH: t("图片实际格式与声明的类型不一致，请重新复制粘贴。"),
  INVALID_IMAGE: t("图片已损坏或格式无法识别，请重新复制粘贴。"),
  INVALID_IMAGE_BASE64: t("图片数据不完整，请重新复制粘贴。"),
  INVALID_ATTACHMENT_REF: t("这个图片引用无效（会话记录里查不到）。"),
  ATTACHMENT_NOT_FOUND: t("这张图片在本体里已不存在（可能已被清理）。"),
  ATTACHMENT_NOT_REFERENCED: t("这张图片不属于当前会话，本体拒绝读取。"),
  ATTACHMENT_CORRUPT: t("本体里的这张图片已损坏，无法读取。"),
  ATTACHMENT_READ_FAILED: t("本体读取这张图片失败。"),
  ATTACHMENT_WRITE_FAILED: t("本体保存这张图片失败（磁盘或权限问题）。"),
  // 0.2.1 additions (same attachment core, more call sites reach them)
  QUEUE_EDIT_NON_TEXT: t("队列里的消息只支持编辑文字内容。"),
  FILE_NOT_STAGED: t("这个文件没有上传到本会话，请重新附加。"),
};

/**
 * Turn any request failure into Chinese panel copy — presentation only.
 *
 * The harness answers refusals with English code+message pairs
 * (`attachment-error` with a `details.reason`, `model-unavailable`, …). Shown
 * verbatim they read like a defect in this extension, so every harness refusal
 * is translated AND explicitly attributed to DSH core; an unknown refusal keeps
 * its code for support while still naming the source. Local (VS Code / fs)
 * failures just get the Chinese prefix.
 */
/**
 * The three permission presets every DSH deployment ships (web GUI header
 * select). 0.2.1's `permissions` projection carries only the CURRENT value, so
 * this roster is the fallback that keeps the select renderable.
 */
const PERMISSION_PRESETS = ["read-only", "workspace-write", "danger-full-access"] as const;

function describeHarnessFailure(prefix: string, error: unknown): string {
  if (error instanceof RpcErrorResult) {
    const { code, message, details } = error.rpcError;
    const reason = typeof details.reason === "string" ? details.reason : undefined;
    // DSH 0.2.1 funnels EVERY image refusal through `session/attachment-invalid`
    // with the attachment-core reason code in `details.reason`
    // (dsh-api-session-controller/lib/index.js:940,960,987,995). 0.1.x used a
    // bare `attachment-error`; both spellings are accepted so the copy table
    // keeps working if the code moves again.
    if ((code === "session/attachment-invalid" || code === "attachment-error") && reason && ATTACHMENT_REASON_COPY[reason]) {
      return tf("{0}：{1}（DSH 本体限制，不是本扩展的问题）", prefix, ATTACHMENT_REASON_COPY[reason]);
    }
    if (reason === "MODEL_DOES_NOT_SUPPORT_IMAGES" || code === "session/model-unavailable" || code === "model-unavailable") {
      return tf(
        "{0}：该模型不接受图像输入，而本会话已包含图片（DSH 本体的限制，不是本扩展的问题）。请改选支持图像输入的模型。",
        prefix,
      );
    }
    return tf("{0}：DSH 本体拒绝了这次请求（{1}）。原文：{2}", prefix, code, message);
  }
  return `${prefix}：${(error as Error).message}`;
}

/**
 * Phase 1 — native sidebar chat panel.
 * Renders the conversation natively (VS Code themed), driven by the mux event
 * stream + session.history, with prompt via session.prompt. This replaces the
 * embedded DSH webview as the main surface (embed moves to dsh.openWebView).
 */
export class NativePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "dsh.sidebar.right";

  private view?: vscode.WebviewView;
  private client: HarnessClient | null = null;
  private stream: HarnessEventStream | null = null;
  private activeSessionId: string | null = null;
  /**
   * Latest projection unit per (session, key). DSH 0.2.1 pushes projections on
   * `session/control` and puts only HINTS on the `session/list` rows, so the
   * list's title / token usage / stats are read from here.
   */
  private readonly projectionCache = new Map<string, Map<string, unknown>>();
  /** Archived session ids — 0.2.1 keeps them on the workspace follow baseline, not on session rows. */
  private archivedSessionIds = new Set<string>();
  /** Workspace rows from the follow baseline: the picker's grouping source. */
  private workspaces: WorkspaceView[] = [];
  private sessions: PanelSession[] = [];
  private titles = new Map<string, string>();
  private connected = false;
  private version?: string;
  private phase: "searching" | "starting" | "online" | "offline" = "searching";
  /** Live todo list of the active session (todos projection, realtime mux push). */
  private todos: TodoItem[] = [];
  /** Current permission presets of the active session (permissions projection,
   *  seeded from history tail + refreshed by session/projection pushes).
   *  Wire values: read-only / workspace-write / danger-full-access. */
  private permissions: { options: { value: string; name?: string }[]; currentValue?: string } | null = null;
  /**
   * Pending file-mutation calls (callId → name+args), kept so the tool/result
   * can refine the bridge-computed diff with the tool's own meta.diffs hunks.
   */
  private pendingArgs = new Map<string, { name: string; args: Record<string, unknown>; path?: string }>();
  private readonly maxPendingArgs = 400;
  /** Context block of a pending in-panel ask card (set by showAskCard). */
  private askContext: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (message: string) => void,
    private readonly getClient: () => HarnessClient | null,
    private readonly onSessionEvent: (cb: (sessionId: string, event: PanelEvent) => void) => void,
    /** Panel liveness for the status bar: `true` = webview never started. */
    private readonly onPanelDead: (dead: boolean) => void = () => undefined,
    /** First paint is being deferred while the editor starts up. */
    private readonly onPanelStarting: (starting: boolean) => void = () => undefined,
    /** How soon this instance started after the previous quit, for diagnostics. */
    private readonly startupGapMs?: number
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
    };
    this.attachPanelHtml();
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.onMessage(message as WebviewMessage);
    });
    // Route mux events into this panel (filtered by active session host-side).
    this.onSessionEvent((sessionId, event) => {
      this.trackRunning(sessionId, event);
      if (sessionId !== this.activeSessionId) return;
      if (event.type === "session/queue") {
        // Queue state snapshot — render the pending-send rows above the input.
        const data = (event.data ?? {}) as { items?: { id?: unknown; placement?: unknown; message?: { content?: { type?: string; text?: string }[] } }[] };
        this.post({
          type: "queue",
          sessionId,
          items: (data.items ?? []).map((it) => ({
            id: String(it.id ?? ""),
            placement: String(it.placement ?? "queued"),
            text: (it.message?.content ?? [])
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join(""),
          })),
        });
        return;
      }
      if (event.type === "session/projection") {
        // Realtime projection push — the `todos` unit carries the current
        // turn's whole task list, reset to null on every turn/start (mirrors
        // the web GUI's task bar exactly). The `permissions` unit carries the
        // session's permission presets (header 权限 select). Other projection
        // frames fall through to the generic event path below.
        // 0.2.1 delivers these on the host-wide session/control stream and keeps
        // the session LIST rows free of values, so every unit is cached for the
        // list render (title / tokenUsage / sessionStats / contextPressure).
        const data = (event.data ?? {}) as { key?: unknown; value?: unknown };
        if (typeof data.key === "string") this.rememberProjection(sessionId, data.key, data.value);
        // The composer's status line (context ring / rounds / timings / tokens)
        // is fed by these three units. They used to reach the panel only on the
        // next full session-list refresh, and the list rows carry them as bare
        // hints — so the line stayed empty unless a refresh happened to land
        // while the values were already cached.
        if (
          data.key === "tokenUsage" ||
          data.key === "sessionStats" ||
          data.key === "contextPressure"
        ) {
          this.post({
            type: "sessionMetrics",
            sessionId,
            usage: this.projectionValue(sessionId, "tokenUsage"),
            stats: this.projectionValue(sessionId, "sessionStats"),
            context: this.projectionValue(sessionId, "contextPressure"),
          });
        }
        if (data.key === "todos") {
          this.todos = Array.isArray(data.value) ? (data.value as TodoItem[]) : [];
          this.post({ type: "todos", sessionId, items: this.todos });
          return;
        }
        if (data.key === "permissions") {
          this.applyPermissions(data.value as { options?: { value: string; name?: string }[]; currentValue?: string } | undefined);
          return;
        }
      }
      // Bridge-computed per-call line diffs ride alongside the raw event so
      // the panel can show "+N-M" on the tool card immediately (and refine it
      // once the tool's own result-time hunks land).
      if (event.type === "tool/call") {
        this.handleToolCallDiff(sessionId, event);
      } else if (event.type === "tool/result") {
        this.handleToolResultDiff(sessionId, event);
      }
      // Answerable interactions no longer ride the session event stream: DSH
      // 0.2.1 forwards `approval/request` and `user-questions/request` as
      // waterfalls on the `$events` stream, which the host hands to
      // handleAnswerable()/handleAnswerableSettled() instead.
      this.post({ type: "event", sessionId, event });
    });
    // Keep the @ file index fresh.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.buildFileIndex()),
      vscode.workspace.onDidCreateFiles(() => void this.buildFileIndex()),
      vscode.workspace.onDidDeleteFiles(() => void this.buildFileIndex())
    );
  }

  /** Called by extension.ts when harness connectivity changes. */
  setClient(client: HarnessClient | null, version?: string): void {
    this.client = client;
    this.connected = client !== null;
    this.version = version;
    this.phase = client ? "online" : "offline";
    void this.refresh();
  }

  /** Loading-phase hint from the extension (searching / starting). */
  setPhase(phase: "searching" | "starting" | "online" | "offline"): void {
    this.phase = phase;
    this.postState();
  }

  /**
   * (Re)attach the live event stream. The panel owns "which session is
   * followed": the transport carries exactly ONE `session/follow` stream, so
   * the provider re-points it whenever the active session changes.
   */
  attachStream(stream: HarnessEventStream | null): void {
    this.stream = stream;
    this.followActive();
  }

  /** Point the live follow stream at the active session (no-op when unchanged). */
  private followActive(): void {
    this.stream?.followSession(this.activeSessionId);
  }

  /** Archived-session set from the workspace follow baseline (0.2.1 moved it off the rows). */
  setArchivedSessionIds(archived: string[] | undefined): void {
    if (Array.isArray(archived)) this.archivedSessionIds = new Set(archived);
  }

  /**
   * Workspace rows from the same baseline. The session rows carry no
   * `workspaceId`, so membership is resolved through each workspace's
   * `sessionIds` — exactly the relation the web GUI groups by.
   */
  setWorkspaces(items: WorkspaceView[]): void {
    this.workspaces = Array.isArray(items) ? items : [];
  }

  /**
   * `$events/result` needs the forwarded-event client id handed out by the live
   * `$events` stream; without it an answer cannot be correlated.
   */
  private remoteClientId(): string {
    const id = this.stream?.remoteClientId;
    if (!id) throw new Error(t("事件流尚未就绪（缺少 $events clientId），请稍后重试"));
    return id;
  }

  /** Cache one projection unit (0.2.1 pushes these on session/control). */
  private rememberProjection(sessionId: string, key: string, value: unknown): void {    let map = this.projectionCache.get(sessionId);
    if (!map) {
      map = new Map();
      this.projectionCache.set(sessionId, map);
    }
    map.set(key, value);
  }

  private projectionValue<T>(sessionId: string, key: string): T | undefined {
    return this.projectionCache.get(sessionId)?.get(key) as T | undefined;
  }

  /**
   * Apply the permissions projection. 0.2.1 publishes only `currentValue` (the
   * preset id) — the roster itself no longer rides the projection — so fall
   * back to the three presets every deployment ships, which is exactly what the
   * header select offers.
   */
  private applyPermissions(value: { options?: { value: string; name?: string }[]; currentValue?: string } | undefined): void {
    if (!value) return;
    const options =
      Array.isArray(value.options) && value.options.length > 0
        ? value.options
        : PERMISSION_PRESETS.map((preset) => ({ value: preset }));
    this.permissions = { options, currentValue: value.currentValue };
    this.postPermissions();
  }

  /**
   * A forwarded waterfall arrived (`approval/request`, `user-questions/request`).
   * 0.2.1 has no `/api/respond`: the answer rides `$events/result` and is
   * correlated by `eventId` + the stream's `clientId`. The panel's existing
   * interaction card renders it unchanged by reusing `rpcId` as the slot.
   */
  handleAnswerable(answerable: AnswerableEvent): void {
    const sessionId = answerable.sessionId || (this.activeSessionId ?? "");
    if (!sessionId) return;
    const request = answerable.request;
    if (answerable.event === "approval/request") {
      this.post({
        type: "interaction",
        sessionId,
        rpcId: answerable.eventId,
        kind: "approval",
        approvalId: String(request.approvalId ?? request.id ?? ""),
        toolName: String(request.toolName ?? ""),
        callId: request.callId !== undefined ? String(request.callId) : undefined,
        reason: request.reason !== undefined ? String(request.reason) : undefined,
      });
      return;
    }
    if (answerable.event === "user-questions/request") {
      const raw = Array.isArray(request.questions) ? (request.questions as Record<string, unknown>[]) : [];
      this.post({
        type: "interaction",
        sessionId,
        rpcId: answerable.eventId,
        kind: "question",
        questions: raw.map((q) => ({
          id: String(q.id ?? ""),
          question: String(q.question ?? ""),
          detail: q.detail !== undefined ? String(q.detail) : undefined,
          header: q.header !== undefined ? String(q.header) : undefined,
          multiSelect: q.multiSelect === true,
          options: Array.isArray(q.options)
            ? (q.options as Record<string, unknown>[]).map((o) => ({
                label: String(o.label ?? ""),
                description: o.description !== undefined ? String(o.description) : undefined,
              }))
            : undefined,
        })),
      });
    }
  }

  /** The waterfall was answered elsewhere or cancelled by the Host. */
  handleAnswerableSettled(eventId: string): void {
    if (!eventId) return;
    this.post({ type: "interactionSettled", sessionId: this.activeSessionId ?? "", rpcId: eventId });
  }

  /**
   * Show an in-panel "ask about selection" card (preferred path for
   * dsh.askSelection): the editor context block is rendered inside the
   * sidebar with the intent choices, so the whole flow stays in the panel
   * instead of a VS Code quick-pick. The pick is answered via askPick /
   * askCancel and shipped by sendAsk().
   */
  showAskCard(contextBlock: string): void {
    this.askContext = contextBlock;
    this.post({ type: "ask", context: contextBlock, choices: INTENT_CHOICES });
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      this.post({
        type: "state",
        connected: false,
        sessions: [],
        maxAttachBytes: this.maxAttachBytes() ?? null,
        messageTimestamps: this.timestampsEnabled(),
        promptArrowKeys: this.promptArrowMode(),
        activeSessionId: null,
      });
      return;
    }
    try {
      const { items } = await this.client.listSessions();
      // Mirror the official client's session visibility contract
      // (dsh-client-ui-workspace `sessionVisible`): subagent children carry
      // `origin: "subagent"` and are surfaced under their parent conversation
      // via subagent.list, never as standalone sidebar rows. Archived and
      // blank rows are excluded the same way.
      //
      // 0.2.1 changed two inputs: the archived set rides the workspace follow
      // baseline instead of the session rows, and the rows carry only
      // projection HINTS — title/usage/stats come from session/control and are
      // served from the projection cache here.
      const archived = this.archivedSessionIds;
      // sessionId → workspace, from the workspace follow baseline. A session
      // listed by no workspace is the web GUI's "Ungrouped": it renders under
      // its own heading rather than being guessed from `cwd`.
      const workspaceBySession = new Map<string, WorkspaceView>();
      for (const workspace of this.workspaces) {
        for (const sessionId of workspace.sessionIds ?? []) workspaceBySession.set(sessionId, workspace);
      }
      let sessions = items
        .filter((item) => !item.blank && item.origin !== "subagent" && !archived.has(item.sessionId))
        .map((item) => {
          // Seed from the row's own hints BEFORE reading: the local store only
          // sees push frames, so after a host restart every row rendered as
          // "会话 + id" until its session happened to be opened. The host labels
          // these "cached" (last durable checkpoint); any live event for the
          // same key supersedes them.
          const hints = item.projections?.values;
          if (hints) {
            for (const [key, value] of Object.entries(hints)) {
              this.rememberProjection(item.sessionId, key, value);
            }
          }
          return {
            sessionId: item.sessionId,
            running: item.running,
            blank: item.blank,
            updatedAt: item.updatedAt,
            title: this.projectionValue<string>(item.sessionId, "title") ?? undefined,
            // Grouping key for the picker. The upstream bridge discarded it.
            cwd: item.cwd,
            workspaceId: workspaceBySession.get(item.sessionId)?.workspaceId,
            usage: this.projectionValue<PanelSession["usage"]>(item.sessionId, "tokenUsage"),
            stats: this.projectionValue<PanelSession["stats"]>(item.sessionId, "sessionStats"),
            context: this.projectionValue<PanelSession["context"]>(item.sessionId, "contextPressure"),
            agentPreset: undefined,
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt);
      // A freshly created session is blank until its first prompt; keep it
      // visible as the active session instead of silently reverting.
      if (this.activeSessionId && !sessions.some((s) => s.sessionId === this.activeSessionId)) {
        sessions.unshift({
          sessionId: this.activeSessionId,
          running: false,
          blank: true,
          updatedAt: Date.now(),
          title: t("新会话"),
          // Created from this window, so it belongs to the open folder.
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          workspaceId: this.workspaceIdForFolder(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
          usage: undefined,
          stats: undefined,
          context: undefined,
          agentPreset: undefined,
        });
      }
      this.sessions = sessions;
      if (this.sessions.length > 0 && !this.sessions.some((s) => s.sessionId === this.activeSessionId)) {
        this.activeSessionId = this.sessions[0].sessionId;
      }
      this.followActive();
      this.postState();
      if (this.activeSessionId) {
        await this.loadHistory(this.activeSessionId, undefined);
        await this.postModels();
        await this.postCommands();
        this.postPermissions();
      }
    } catch (error) {
      this.post({ type: "error", message: describeHarnessFailure(t("会话列表失败"), error) });
    }
  }

  private async postCommands(): Promise<void> {
    if (!this.client || !this.activeSessionId) return;
    try {
      const items = await this.client.commandList(this.activeSessionId);
      this.post({ type: "commands", items });
    } catch (error) {
      this.log(`commands: ${(error as Error).message}`);
    }
  }

  /**
   * Resolve the current VS Code workspace folder to a DSH workspace id
   * (registering the path idempotently). No folder open → undefined, and new
   * sessions then fall back to the host's default workspace.
   */
  /** Workspace row whose folder is exactly `folder` (path compare, case-insensitive). */
  private workspaceIdForFolder(folder: string | undefined): string | undefined {
    if (!folder) return undefined;
    const normalise = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const target = normalise(folder);
    return this.workspaces.find((workspace) => normalise(workspace.path) === target)?.workspaceId;
  }

  private async resolveWorkspaceId(): Promise<string | undefined> {
    try {
      if (!this.client) return undefined;
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) return undefined;
      const { workspace } = await this.client.workspaceCreate(folders[0].uri.fsPath);
      return workspace.workspaceId;
    } catch (error) {
      this.log(`workspace: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * Directories a transcript-relative path may be relative to, most specific
   * first: the active session's DSH workspace — that is the session's cwd, and
   * it is *not* necessarily the folder open in VS Code — then the VS Code
   * folders, then the extension host's cwd.
   *
   * Measured case: a session in `…\default-workspace` writes `renders/x.png`,
   * while the editor has `…\StrategyGamev1` open. Resolving against the editor
   * folder alone reported ENOENT for a file that exists.
   */
  private localBaseDirs(): string[] {
    const dirs: string[] = [];
    const sessionId = this.activeSessionId;
    if (sessionId) {
      for (const workspace of this.workspaces) {
        if ((workspace.sessionIds ?? []).includes(sessionId) && workspace.path) dirs.push(workspace.path);
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) dirs.push(folder.uri.fsPath);
    dirs.push(process.cwd());
    return [...new Set(dirs)];
  }

  /**
   * Size cap for anything this extension reads on the panel's behalf, in bytes.
   *
   * `dshVsc.maxAttachMB: 0` means disabled — a single value instead of a
   * boolean, so there is no second "enabled" state to test. The default (50 MB)
   * matches DSH Web Chat, and is a transport guard: the harness still applies
   * its own admission limits to images, and stores generic files verbatim.
   */
  private maxAttachBytes(): number | undefined {
    const mb = vscode.workspace.getConfiguration("dshVsc").get<number>("maxAttachMB", 50);
    return typeof mb === "number" && mb > 0 ? Math.floor(mb * 1024 * 1024) : undefined;
  }

  /**
   * Open a local file in the editor.
   *
   * A Windows path handed to `openExternal` parses as scheme "c" and the shell
   * launch fails with 0x2 ("cannot find the file"); a missing target is
   * reported here instead of being thrown at the OS.
   */
  private openLocalTarget(raw: string): void {
    let abs = raw.trim();
    if (/^file:/i.test(abs)) {
      try {
        abs = vscode.Uri.parse(abs).fsPath;
      } catch {
        /* keep the raw string */
      }
    }
    try {
      abs = decodeURIComponent(abs);
    } catch {
      /* already decoded */
    }
    if (!path.isAbsolute(abs)) {
      const bases = this.localBaseDirs();
      abs = bases.map((base) => path.join(base, abs)).find((candidate) => fs.existsSync(candidate)) ?? path.join(bases[0], abs);
    }
    if (!fs.existsSync(abs)) {
      this.post({ type: "error", message: `File not found: ${abs}` });
      return;
    }
    void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true }).then(
      () => undefined,
      (error) => this.post({ type: "error", message: describeHarnessFailure(t("打开文件失败"), error) }),
    );
  }

  private async onMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "panelReady") {
      this.panelReady = true;
      this.healNotified = false;
      this.onPanelDead(false);
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = undefined;
      }
      return;
    }
    // Clipboard work is local to the window and must not depend on the harness
    // being reachable — "harness 未连接" used to swallow a copy outright.
    if (message.type === "copyText") {
      await this.handleCopy(message.text, message.requestId);
      return;
    }
    // TEMP DIAGNOSTIC: the panel echoes what it received, so a lost reply is
    // visible in the DSH Bridge log instead of being guessed at.
    if (message.type === "panelLog") {
      this.log(`panel: ${String(message.text ?? "")}`);
      return;
    }
    // Image copy is local too: the clipboard is the destination, the harness is
    // irrelevant. This is what the native right-click "Copy" cannot do — it
    // copies the selection as text, and a webview has no image on it.
    if (message.type === "copyImage") {
      const mediaType = String(message.mediaType ?? "image/png");
      const data = String(message.data ?? "");
      this.log(`copyImage: ${mediaType}, ${Math.round((data.length * 3) / 4 / 1024)} KB`);
      try {
        let result = await writeClipboardImage(mediaType, data);
        // The writer proves its own write in-process (GetImage after SetImage, so
        // no second PowerShell spawn); a non-ok result means "locked or not
        // decodable", which is worth exactly one retry.
        if (!result.ok) result = await writeClipboardImage(mediaType, data);
        this.log(`copyImage: ${result.ok ? "ok" : `failed — ${result.error}`}`);
        if (result.ok) this.post({ type: "copyResult", ok: true, message: t("图片已复制") });
        else this.post({ type: "copyResult", ok: false, message: tf("复制失败：{0}", result.error) });
      } catch (error) {
        // Never leave the panel waiting: an unexpected throw must still resolve.
        this.log(`copyImage: threw — ${String(error)}`);
        this.post({ type: "copyResult", ok: false, message: tf("复制失败：{0}", String(error)) });
      }
      return;
    }
    if (!this.client) {
      this.post({ type: "error", message: t("harness 未连接") });
      return;
    }
    switch (message.type) {
      case "readClipboardImage": {
        // A webview paste event carries text but not OS image bytes; read the
        // platform clipboard here and hand the panel a base64 PNG. Failures are
        // reported, not thrown — drag & drop keeps working regardless.
        const clipboard = await readClipboardImage();
        if (clipboard.ok) {
          // The clipboard is the one input we cannot pre-check: the bytes are
          // already read by the time we see them, so the cap applies after.
          const cap = this.maxAttachBytes();
          const bytes = Math.floor((clipboard.data.length * 3) / 4);
          if (cap !== undefined && bytes > cap) {
            this.post({
              type: "clipboardImage",
              requestId: message.requestId,
              error: tf("附件过大：{0} MB", (bytes / 1024 / 1024).toFixed(1)),
            });
            break;
          }
          this.post({
            type: "clipboardImage",
            requestId: message.requestId,
            mediaType: clipboard.mediaType,
            data: clipboard.data,
          });
        } else {
          this.post({ type: "clipboardImage", requestId: message.requestId, error: clipboard.error });
        }
        break;
      }
      case "ready":
        this.postState();
        if (this.activeSessionId) {
          await this.loadHistory(this.activeSessionId, undefined);
        }
        await this.buildFileIndex();
        // Seed the ＋ mode dropdown with the agent-preset roster.
        await this.postAgentPresets();
        break;
      case "selectSession":
        this.activeSessionId = message.sessionId;
        // 0.2.1 carries ONE session/follow stream: re-point it at the session
        // the user just opened before history is requested, so the log cut and
        // live events belong to the same session.
        this.followActive();
        // State first: the panel drops history frames for any session that is
        // not its current activeSessionId, so switch the panel's identity
        // before shipping history, or the page gets wiped to "no messages".
        this.postState();
        await this.loadHistory(message.sessionId, undefined);
        await this.postModels();
        await this.postCommands();
        this.postPermissions();
        break;
      case "getModels":
        await this.postModels();
        break;
      case "selectModel": {
        if (!this.activeSessionId) break;
        try {
          const selected = await this.client.selectModel(this.activeSessionId, message.provider, message.model, message.reasoningEffort);
          // The model catalog can still report the PREVIOUS default for a few
          // hundred ms after a switch (measured: stale immediately, correct at
          // ~400ms). Reflecting the stale value here is what made the picker
          // need two clicks. Post the confirmed selection now, then reconcile.
          await this.postModels({
            provider: message.provider,
            model: message.model,
            reasoningEffort: selected?.selected?.reasoningEffort ?? message.reasoningEffort,
          });
          setTimeout(() => {
            void this.postModels();
          }, 500);
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("切换模型失败"), error) });
        }
        break;
      }
      case "getAttachment": {
        // Transcript images are stored as refs in the log; bytes come back
        // through the harness's own session.attachment RPC (which refuses ids
        // the named session never referenced). Failures degrade to a labeled
        // placeholder rather than an empty box.
        const sessionId = message.sessionId || this.activeSessionId;
        try {
          if (!sessionId) throw new Error(t("没有活动会话"));
          const value = await this.client.sessionAttachment(sessionId, message.attachmentId);
          this.post({
            type: "attachment",
            requestId: message.requestId,
            attachmentId: message.attachmentId,
            mediaType: value.attachment.mediaType,
            data: value.data,
            width: value.attachment.width,
            height: value.attachment.height,
            bytes: value.attachment.bytes,
            name: value.attachment.name,
          });
        } catch (error) {
          this.post({
            type: "attachment",
            requestId: message.requestId,
            attachmentId: message.attachmentId,
            error: describeHarnessFailure(t("读取图片失败"), error),
          });
        }
        break;
      }
      case "readImage": {
        // The assistant links images by absolute path (`![alt](D:\out\x.png)`)
        // and a webview can never load a file:// path — CSP blocks it and the
        // row degrades to a broken-image icon. Read it here and hand the panel
        // a data: URL. Extensions are allow-listed so a message can never turn
        // this into an arbitrary file read.
        try {
          const raw = String(message.path ?? "").trim();
          if (!raw) throw new Error(t("空路径"));
          let decoded = raw;
          try {
            decoded = decodeURIComponent(raw);
          } catch {
            /* already decoded */
          }
          // The assistant writes workspace-relative paths (`renders/x.png`),
          // relative to the *session's* workspace — try that first, then the
          // editor's folders, then the host cwd.
          const candidates: string[] = [];
          if (path.isAbsolute(decoded)) {
            candidates.push(decoded);
          } else {
            for (const base of this.localBaseDirs()) candidates.push(path.join(base, decoded));
          }
          const exists = (candidate: string): boolean => {
            try {
              return fs.statSync(candidate).isFile();
            } catch {
              return false;
            }
          };
          const abs = candidates.find(exists) ?? candidates[0];
          const mime: Record<string, string> = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".gif": "image/gif",
            ".bmp": "image/bmp",
            ".avif": "image/avif",
          };
          const type = mime[path.extname(abs).toLowerCase()];
          if (!type) throw new Error(`不支持的图片类型：${path.extname(abs) || t("（无扩展名）")}`);
          const stat = fs.statSync(abs);
          if (!stat.isFile()) throw new Error(t("不是文件"));
          const cap = this.maxAttachBytes();
          if (cap !== undefined && stat.size > cap) {
            throw new Error(tf("附件过大：{0} MB", (stat.size / 1024 / 1024).toFixed(1)));
          }
          this.post({
            type: "imageData",
            requestId: message.requestId,
            mediaType: type,
            data: fs.readFileSync(abs).toString("base64"),
            attach: message.attach === true,
          });
        } catch (error) {
          this.post({
            type: "imageData",
            requestId: message.requestId,
            error: describeHarnessFailure(t("读取本地图片失败"), error),
            attach: message.attach === true,
          });
        }
        break;
      }
      case "newSession": {
        try {
          const workspaceId = await this.resolveWorkspaceId();
          const opts: { workspaceId?: string; agentPreset?: string } = {};
          if (workspaceId) opts.workspaceId = workspaceId;
          // Optional mode pick: the panel sends agentPreset when the user chose
          // one from the ＋ dropdown (标准 / PTC / 极简 / 创造 = agent presets).
          if (message.agentPreset) opts.agentPreset = message.agentPreset;
          const { sessionId } = await this.client.createSession(opts);
          this.activeSessionId = sessionId;
          this.followActive();
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("新建会话失败"), error) });
        }
        break;
      }
      case "deleteSession": {
        if (!this.activeSessionId) break;
        try {
          // Delete == archive. `stopActivity` matches the official client's
          // delete button: 0.2.1 otherwise refuses with WorkspaceActiveSessionError
          // while the session still has a running turn / job / subagent.
          const { archivedSessionIds } = await this.client.archiveSession(message.sessionId, {
            stopActivity: true,
          });
          // The RPC answers with the complete durable archive set — adopt it
          // here rather than waiting for the workspace follow frame, so the
          // row is gone by the time `refresh()` rebuilds the list.
          if (Array.isArray(archivedSessionIds)) {
            this.archivedSessionIds = new Set(archivedSessionIds);
          }
          if (this.activeSessionId === message.sessionId) {
            this.activeSessionId = null;
            this.followActive();
          }
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("删除会话失败"), error) });
        }
        break;
      }
      case "askPick": {
        const context = this.askContext;
        this.askContext = null;
        if (!context || !this.client) {
          this.post({ type: "error", message: t("Ask 卡片已失效，请重新选中代码再试。") });
          break;
        }
        const choice = INTENT_CHOICES.find((c) => c.id === message.choiceId);
        let instruction: string;
        if (choice && choice.id !== "custom") {
          instruction = choice.label;
        } else {
          const custom = (message.customText ?? "").trim();
          if (!custom) {
            this.post({ type: "error", message: t("请输入指令。") });
            break;
          }
          instruction = custom;
        }
        try {
          await sendAsk(this.client, context, instruction);
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("发送失败"), error) });
        }
        break;
      }
      case "askCancel":
        this.askContext = null;
        break;
      case "respondApproval": {
        if (!this.client) {
          this.post({ type: "error", message: t("harness 未连接") });
          break;
        }
        try {
          // 0.2.1: approvals are forwarded waterfalls answered through
          // `$events/result`; the waterfall's RESULT VALUE is the outcome
          // (`allowed-once` / `rejected`), correlated by the event id the card
          // was rendered with.
          await this.client.answerRemoteEvent(this.remoteClientId(), message.rpcId, {
            kind: "result",
            value: message.outcome,
          });
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("审批应答失败"), error) });
        }
        break;
      }
      case "respondQuestion": {
        if (!this.client) {
          this.post({ type: "error", message: t("harness 未连接") });
          break;
        }
        try {
          await this.client.answerRemoteEvent(this.remoteClientId(), message.rpcId, {
            kind: "result",
            value: { answers: message.answers },
          });
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("选择题应答失败"), error) });
        }
        break;
      }
      case "getPermissions":
        this.postPermissions();
        break;
      case "getAgentPresets":
        await this.postAgentPresets();
        break;
      case "selectPermission": {
        if (!this.activeSessionId) break;
        try {
          // Same admission path as the web composer's /permission picker:
          // run the slash command against the session's agent.
          const outcome = await this.client?.commandExecute(this.activeSessionId, `/permission ${message.permission}`);
          if (outcome === undefined || (outcome as { matched?: boolean }).matched === false) {
            this.post({ type: "error", message: t("切换权限失败: host 未提供 /permission 命令") });
          }
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("切换权限失败"), error) });
        }
        break;
      }
      case "openFile": {
        this.openLocalTarget(String(message.path ?? ""));
        break;
      }
      case "openExternal": {
        try {
          const raw = String(message.url ?? "");
          // Only a real URL may reach the shell. `C:\…` reads "c" as a scheme
          // and a relative path has no scheme at all; both die with 0x2
          // ("cannot find the file"), so anything else is opened as a file.
          if (!/^(?:https?:\/\/|mailto:)/i.test(raw)) {
            this.openLocalTarget(raw);
            break;
          }
          const uri = vscode.Uri.parse(raw);
          void vscode.env.openExternal(uri).then(
            () => undefined,
            (error) => this.post({ type: "error", message: describeHarnessFailure(t("打开链接失败"), error) })
          );
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("打开链接失败"), error) });
        }
        break;
      }
      case "openSettings":
        this.openSettingsPanel();
        break;
      case "queueSteer":
      case "queueRemove": {
        if (!this.activeSessionId) break;
        const action: QueueAction = message.type === "queueSteer" ? { kind: "steer" } : { kind: "remove" };
        try {
          await this.client.updateQueue(this.activeSessionId, message.itemId, action);
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("队列操作失败"), error) });
        }
        break;
      }
      case "send": {
        const text = message.text.trim();
        const content: PromptContentPart[] = [];
        for (const a of message.attachments ?? []) {
          content.push({ type: "image", mediaType: a.mediaType, data: a.data, name: a.name });
        }
        if (text) content.push({ type: "text", text });
        if (content.length === 0) return;
        const mode = message.mode ?? "queue";
        let sessionId = this.activeSessionId;
        if (!sessionId) {
          try {
            const workspaceId = await this.resolveWorkspaceId();
            const created = await this.client.createSession(workspaceId ? { workspaceId } : {});
            sessionId = created.sessionId;
            this.activeSessionId = sessionId;
            this.followActive();
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure(t("新建会话失败"), error) });
            return;
          }
        }
        // A leading-slash line is a real slash command — dispatch it through the
        // commands domain instead of sending it to the agent as plain text.
        if (mode === "queue" && text && text.startsWith("/") && content.length === 1) {
          try {
            const outcome = await this.client.commandExecute(sessionId, text);
            this.post({
              type: "cmdResult",
              text: outcome?.result?.text ?? tf("命令已执行：{0}", text),
              ok: outcome?.result?.kind !== "error",
            });
            await this.refresh();
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure(t("命令执行失败"), error) });
          }
          return;
        }
        try {
          await this.client.prompt(sessionId, content, mode);
          this.post({ type: "running", sessionId, running: true });
          await this.refresh();
        } catch (error) {
          this.post({ type: "error", message: describeHarnessFailure(t("发送失败"), error) });
        }
        break;
      }
      case "loadOlder":
        await this.loadHistory(this.activeSessionId ?? "", message.beforeSeq);
        break;
      case "cancel":
        if (this.activeSessionId) {
          try {
            await this.client.cancel(this.activeSessionId);
            this.post({ type: "running", sessionId: this.activeSessionId, running: false });
          } catch (error) {
            this.post({ type: "error", message: describeHarnessFailure(t("停止失败"), error) });
          }
        }
        break;
      case "refresh":
        await this.refresh();
        break;
      case "refreshFiles":
        await this.buildFileIndex();
        break;
    }
  }

  /**
   * Build a workspace file index (files + all ancestor dirs) once and push it
   * to the panel for LOCAL, millisecond @ filtering. Folders sort before files.
   */
  private async buildFileIndex(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.post({ type: "index", files: [], dirs: [] });
      return;
    }
    const root = folders[0].uri.fsPath;
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,dist,.git,out,build,coverage,.vscode-test,.vscode-test-ext}/**",
        500
      );
      uris = uris.filter((uri) => !/\.vsix$/i.test(uri.fsPath));
    } catch {
      /* empty list */
    }
    const files = uris
      .map((uri) => path.relative(root, uri.fsPath).replaceAll("\\", "/"))
      .sort((a, b) => a.localeCompare(b));
    const dirSet = new Set<string>();
    for (const file of files) {
      const parts = file.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirSet.add(parts.slice(0, i).join("/"));
      }
    }
    const dirs = [...dirSet].sort((a, b) => a.localeCompare(b));
    this.post({ type: "index", files, dirs });
  }

  /** Load a history page ending before `beforeSeq` (tail when undefined).
   *  Older pages are prepends (isOlder: true) so the webview can append them
   *  above the current messages without rebuilding the list. */
  private async loadHistory(sessionId: string, beforeSeq?: number): Promise<void> {
    if (!this.client || !sessionId) return;
    try {
      // 0.2.1 split 0.1.x's session.history into session/page (the log) plus
      // session/projections (the projection block), and `session/page` REQUIRES
      // the log cut as `throughSeq`. The follow snapshot is the authority for
      // that cut; a direct projections read is the fallback when no stream is
      // open for this session yet.
      let throughSeq = this.stream?.cursorFor(sessionId);
      let projections: Record<string, unknown> | undefined;
      if (beforeSeq === undefined) {
        // The follow snapshot is the authority for the log cut, and loadHistory
        // runs right after the session is followed — give the snapshot a moment
        // to land before falling back to a direct projections read.
        for (let i = 0; throughSeq === undefined && this.stream !== null && i < 40; i++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throughSeq = this.stream?.cursorFor(sessionId);
        }
        const snapshot = await this.client.projections(sessionId);
        if (snapshot && snapshot.kind === "sequenced") {
          throughSeq = throughSeq ?? snapshot.asOfSeq;
          projections = snapshot.values;
        } else if (snapshot && snapshot.kind === "migration-required") {
          projections = snapshot.values;
        }
      }
      // Last resort: the host rejects a cut past the log end but names the real
      // cursor ("session page through seq N is past cursor M"), so retry once
      // with it instead of guessing a huge number.
      if (throughSeq === undefined) throughSeq = Number.MAX_SAFE_INTEGER;
      let page;
      try {
        page = await this.client.page(sessionId, throughSeq, beforeSeq, 30);
      } catch (error) {
        const text =
          error instanceof RpcErrorResult ? error.rpcError.message : (error as Error).message;
        const past = /past cursor (\d+)/i.exec(text);
        if (!past) throw error;
        page = await this.client.page(sessionId, Number(past[1]), beforeSeq, 30);
      }
      const mapped = page.records.map((entry) => entry.event as PanelEvent);
      const hasMore = page.hasMore;
      // Per-call "+N-M" diffs for this page, shipped inside the history frame
      // so the panel has them in hand while folding the page in.
      const toolDiffs = this.diffEntriesForPage(mapped);
      // Task bar mirrors the web GUI: it renders the host-computed `todos`
      // projection (current turn's todo list; null after a turn/start reset),
      // NOT the raw log. Seed it from the projections snapshot so a freshly
      // opened session shows the same state as the web tab.
      if (beforeSeq === undefined) {
        const todos = projections?.todos;
        this.todos = Array.isArray(todos) ? (todos as TodoItem[]) : [];
        this.post({ type: "todos", sessionId, items: this.todos });
        // Permission presets ride the same projections block (web GUI's
        // 权限 select): seed the header select from it.
        const perms = projections?.permissions as
          | { options?: { value: string; name?: string }[]; currentValue?: string }
          | undefined;
        if (perms) this.applyPermissions(perms);
      }
      this.post({
        type: "history",
        sessionId,
        events: mapped,
        hasMore: hasMore === true,
        isOlder: beforeSeq !== undefined,
        toolDiffs: Object.keys(toolDiffs).length > 0 ? toolDiffs : undefined,
      });
    } catch (error) {
      // Old (0.1.x) logs need a format migration before they can be read, and
      // the 0.2.1 chain can REFUSE them outright — measured on real 0.1.1 logs:
      //   gateway/internal: failed to observe session …:
      //   dsh-session-format-v0-to-v1 refuses this format v0 Session:
      //   permission/preset 0 data has unexpected member "origin"
      // That is core behaviour, so say so instead of leaking a gateway/internal
      // error that reads like a defect in this extension.
      const text =
        error instanceof RpcErrorResult ? `${error.rpcError.code}: ${error.rpcError.message}` : (error as Error).message;
      if (/failed to observe session|refuses this format|migration-required/i.test(text)) {
        this.post({
          type: "error",
          message: tf(
          "读取历史失败：这个会话是 0.1.x 时代的旧日志，DSH 0.2.x 要先做格式迁移，而本体的迁移链拒绝了它（DSH 本体行为，不是本扩展的问题）。原文：{0}",
          text,
        ),
        });
        return;
      }
      this.post({ type: "error", message: describeHarnessFailure(t("读取历史失败"), error) });
    }
  }

  /** Derive per-session running state from turn events. */
  private trackRunning(sessionId: string, event: PanelEvent): void {
    if (event.type === "turn/start") {
      this.post({ type: "running", sessionId, running: true });
    } else if (event.type === "turn/end") {
      this.post({ type: "running", sessionId, running: false });
    } else if (event.type === "session/title") {
      const title = (event.data as { title?: string } | undefined)?.title;
      if (typeof title === "string") {
        this.titles.set(sessionId, title);
        // 0.2.1: the title is a projection; cache it so refresh() can render it.
        this.rememberProjection(sessionId, "title", title);
        if (sessionId === this.activeSessionId) this.postState();
      }
    }
  }

  /* ---------- bridge-computed per-tool line diffs ("+N-M") ---------- */

  /** Resolve a possibly-relative tool path — same base order as images: the
   *  session's workspace first, because the open folder is not necessarily the
   *  folder the agent was working in. */
  private resolveToolPath(raw: string): string | null {
    if (!raw || raw.trim().length === 0) return null;
    if (path.isAbsolute(raw)) return raw;
    const bases = this.localBaseDirs();
    return (
      bases.map((base) => path.join(base, raw)).find((candidate) => fs.existsSync(candidate)) ??
      path.join(bases[0], raw)
    );
  }

  /** Pre-write content of a file (best effort; the harness usually applies
   *  the mutation after emitting tool/call, so this is the old version). */
  private readOldFile(raw: string): string | null {
    const abs = this.resolveToolPath(raw);
    if (!abs) return null;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) return null;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  private parseToolArgs(argumentsText: unknown): Record<string, unknown> {
    try {
      const parsed = JSON.parse(String(argumentsText ?? "{}")) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  private rememberPendingArgs(callId: string, name: string, args: Record<string, unknown>, filePath?: string): void {
    this.pendingArgs.set(callId, { name, args, path: filePath });
    if (this.pendingArgs.size > this.maxPendingArgs) {
      const oldest = this.pendingArgs.keys().next().value;
      if (oldest !== undefined) this.pendingArgs.delete(oldest);
    }
  }

  /** tool/call: count from the arguments alone (visible while still running). */
  private handleToolCallDiff(sessionId: string, event: PanelEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const name = String(data.name ?? "");
    const callId = String(data.callId ?? "");
    if (!name || !callId) return;
    const args = this.parseToolArgs(data.arguments);
    const diff = countToolArgsDiff(name, args, (p) => this.readOldFile(p));
    if (diff) {
      const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
      const filePath = this.resolveToolPath(rawPath) ?? (rawPath || undefined);
      this.rememberPendingArgs(`${sessionId}:${callId}`, name, args, filePath);
      this.post({ type: "toolDiff", sessionId, callId, added: diff.added, deleted: diff.deleted, path: filePath });
    }
  }

  /** tool/result: refine with the tool's own result-time hunks (meta.diffs). */
  private handleToolResultDiff(sessionId: string, event: PanelEvent): void {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const msg = (data.message ?? {}) as Record<string, unknown>;
    let callId = String(data.callId ?? "");
    if (!callId && Array.isArray(msg.content)) {
      for (const block of msg.content as Record<string, unknown>[]) {
        if (block && block.type === "tool-result" && block.toolCallId) {
          callId = String(block.toolCallId);
          break;
        }
      }
    }
    if (!callId) return;
    const pending = this.pendingArgs.get(`${sessionId}:${callId}`);
    if (!pending) return;
    this.pendingArgs.delete(`${sessionId}:${callId}`);
    const refined = countMetaDiff(data.meta, pending.name, pending.args);
    if (refined) {
      this.post({ type: "toolDiff", sessionId, callId, added: refined.added, deleted: refined.deleted, path: pending.path });
    }
  }

  /**
   * History path: recompute the per-call diffs for one page and ship them as a
   * map (the panel merges it before applying the page's events). tool/result
   * hunks win over arg-based counts, matching the live path.
   */
  private diffEntriesForPage(events: PanelEvent[]): Record<string, ToolLineDiff> {
    const entries: Record<string, ToolLineDiff> = {};
    const pending = new Map<string, { name: string; args: Record<string, unknown>; path?: string }>();
    for (const ev of events) {
      const data = (ev.data ?? {}) as Record<string, unknown>;
      if (ev.type === "tool/call") {
        const name = String(data.name ?? "");
        const callId = String(data.callId ?? "");
        if (!name || !callId) continue;
        const args = this.parseToolArgs(data.arguments);
        const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
        const filePath = this.resolveToolPath(rawPath) ?? (rawPath || undefined);
        pending.set(callId, { name, args, path: filePath });
        const diff = countToolArgsDiff(name, args, (p) => this.readOldFile(p));
        if (diff) entries[callId] = { ...diff, path: filePath };
      } else if (ev.type === "tool/result") {
        const msg = (data.message ?? {}) as Record<string, unknown>;
        let callId = String(data.callId ?? "");
        if (!callId && Array.isArray(msg.content)) {
          for (const block of msg.content as Record<string, unknown>[]) {
            if (block && block.type === "tool-result" && block.toolCallId) {
              callId = String(block.toolCallId);
              break;
            }
          }
        }
        if (!callId) continue;
        const call = pending.get(callId);
        if (!call) continue;
        const refined = countMetaDiff(data.meta, call.name, call.args);
        if (refined) entries[callId] = { ...refined, path: call.path };
      }
    }
    return entries;
  }

  private async postModels(override?: { provider: string; model: string; reasoningEffort?: string }): Promise<void> {
    if (!this.client || !this.activeSessionId) return;
    try {
      // 0.2.1 renamed the RPC (session/models -> session/modelCatalog) and
      // reshaped the value: `default` replaces `current`, `routableProviders`
      // replaces `routable`.
      const catalog = await this.client.modelCatalog();
      // `default` lags a just-made selection for a moment, so a caller that
      // just selected a model passes the confirmed value to paint immediately.
      const current = override
        ? {
            ...catalog.default,
            provider: override.provider,
            model: override.model,
            ...(override.reasoningEffort !== undefined ? { reasoningEffort: override.reasoningEffort } : {}),
          }
        : catalog.default;
      this.post({
        type: "models",
        current,
        groups: catalog.groups.map((g) => ({
          id: g.id,
          name: g.name,
          models: g.models.map((m) => ({
            id: m.id,
            name: m.name,
            // The harness reports each model's real reasoning efforts (off/low/
            // high/max...) — carry them through so the effort selector renders
            // the OFFICIAL set instead of a hardcoded list.
            ...(m.reasoning ? { reasoning: m.reasoning } : {}),
          })),
        })),
      });
    } catch (error) {
      // Model catalog is advisory; fail silently rather than spamming errors.
      this.log(`models: ${(error as Error).message}`);
    }
  }

  private async postPermissions(): Promise<void> {
    // Post the cached permissions projection (seeded from history tail,
    // refreshed by session/projection pushes). Header labels come from the
    // known three presets (web GUI semantics: 仅可查看 / 可写入工作区 / 完全权限).
    if (!this.permissions || this.permissions.options.length === 0) {
      this.post({ type: "permissions", options: [], current: undefined });
      return;
    }
    const LABELS: Record<string, string> = {
      "read-only": t("仅可查看"),
      "workspace-write": t("可写入工作区"),
      "danger-full-access": t("完全权限"),
    };
    this.post({
      type: "permissions",
      options: this.permissions.options.map((o) => ({
        value: o.value,
        label: LABELS[o.value] ?? o.name ?? o.value,
      })),
      current: this.permissions.currentValue,
    });
  }

  /** Push the agent-preset roster (＋ 新建会话的模式下拉) to the panel. Display
   *  copy: the live roster's own name/description when present, otherwise the
   *  official shipped copy for the four built-in presets. Roster order is the
   *  host's (order field in preset.yml), so 标准/PTC/极简/创造 appear in the
   *  dropdown in the official order. If the roster is empty or unreachable
   *  (e.g. an older harness without the agent-presets domain), fall back to
   *  the four shipped presets so the picker always offers the modes. */
  private async postAgentPresets(): Promise<void> {
    if (!this.client) return;
    const officialRows = (presets: { id: string; name?: string; description?: string; isDefault?: boolean }[]) =>
      presets.map((p) => {
        const official = OFFICIAL_PRESET_COPY[p.id];
        return {
          id: p.id,
          name: p.name ?? official?.name,
          description: p.description ?? official?.description,
          isDefault: p.isDefault === true,
        };
      });
    try {
      const { presets } = await this.client.agentPresets();
      // 0.2.1 roster rows carry ONLY id/order/isDefault — no name, description,
      // trust or broken flag. Display copy therefore comes from the shipped
      // official roster, and the host's `order` drives the dropdown order.
      const rows = [...presets]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((p) => ({
          id: p.id,
          name: OFFICIAL_PRESET_COPY[p.id]?.name ?? p.id,
          description: OFFICIAL_PRESET_COPY[p.id]?.description,
          isDefault: p.isDefault === true,
        }));
      if (rows.length === 0) {
        // Empty roster: deployment composes no presets — fall back to the
        // four shipped modes (the normal dsh deployment ships all four).
        this.post({
          type: "agentPresets",
          presets: officialRows(
            Object.keys(OFFICIAL_PRESET_COPY).map((id) => ({ id, isDefault: id === "standard" }))
          ),
        });
        return;
      }
      this.post({ type: "agentPresets", presets: rows });
    } catch (error) {
      this.log(`agentPresets: ${(error as Error).message}`);
      this.post({
        type: "agentPresets",
        presets: officialRows(
          Object.keys(OFFICIAL_PRESET_COPY).map((id) => ({ id, isDefault: id === "standard" }))
        ),
      });
    }
  }

  /** "history" (terminal Up/Down) or "caret" (editor-style arrows). */
  private promptArrowMode(): "history" | "caret" {
    const value = vscode.workspace.getConfiguration("dshVsc").get<string>("promptArrowKeys", "history");
    return value === "caret" ? "caret" : "history";
  }

  /** Transcript times: user messages and turn labels. */
  private timestampsEnabled(): boolean {
    return vscode.workspace.getConfiguration("dshVsc").get<boolean>("messageTimestamps", true) !== false;
  }

  private postState(): void {
    this.post({
      type: "state",
      connected: this.connected,
      version: this.version,
      phase: this.phase,
      // The panel checks `file.size` before reading bytes (drop / paste), so the
      // cap has to travel with the state. `null` means disabled.
      maxAttachBytes: this.maxAttachBytes() ?? null,
        messageTimestamps: this.timestampsEnabled(),
        promptArrowKeys: this.promptArrowMode(),
      // live title event wins; otherwise the projection title from session.list
      sessions: this.sessions.map((s) => ({ ...s, title: this.titles.get(s.sessionId) ?? s.title })),
      // Workspace rows in host order: the picker groups by these, and a session
      // outside every `sessionIds` list is "Ungrouped".
      workspaces: this.workspaces.map((w) => ({ workspaceId: w.workspaceId, title: w.title, path: w.path })),
      activeSessionId: this.activeSessionId,
    });
  }

  /**
   * Write the clipboard from the extension host and VERIFY it by reading back.
   *
   * The webview's own clipboard write is unobservable — Chromium drops it
   * silently, which is how a copy can "succeed" while the clipboard keeps its
   * previous content. Doing the write here makes the outcome knowable, and the
   * read-back makes it provable; a mismatch is surfaced instead of swallowed.
   * Windows newline normalisation (`\n` → `\r\n` on write) is not a failure.
   */
  private async handleCopy(text: string, requestId?: string): Promise<void> {
    const normalise = (value: string): string => value.replace(/\r\n/g, "\n");
    const readBack = async (): Promise<string | undefined> => {
      try {
        return await vscode.env.clipboard.readText();
      } catch {
        return undefined; // an unreadable clipboard says nothing about the write
      }
    };
    let failure: string | undefined;
    try {
      await vscode.env.clipboard.writeText(text);
      const first = await readBack();
      if (first !== undefined && normalise(first) !== normalise(text)) {
        // Give the OS a beat: a write that lands late must not be reported as
        // a failure.
        await new Promise((resolve) => setTimeout(resolve, 80));
        const second = await readBack();
        if (second !== undefined && normalise(second) !== normalise(text)) {
          failure = tf("剪贴板里不是刚复制的内容（要求 {0} 字符，回读 {1} 字符）", text.length, second.length);
        }
      }
    } catch (error) {
      failure = describeHarnessFailure(t("复制失败"), error);
    }
    this.log(`copy ${text.length} chars → ${failure ?? "verified"}`);
    if (failure) this.post({ type: "error", message: failure });
    if (requestId) this.post({ type: "copyResult", requestId, ok: failure === undefined, error: failure });
  }

  private post(message: HostMessage): void {
    try {
      void this.view?.webview.postMessage(message);
    } catch {
      /* panel disposed */
    }
  }

  private renderHtml(): string {
    const panelPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "native", "panel.html");
    let html = fs.readFileSync(panelPath.fsPath, "utf8");
    try {
      const whaleUri = this.view?.webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "dsh-whale.svg")
      );
      html = html.replaceAll("__WHALE_URI__", whaleUri?.toString() ?? "");
    } catch {
      /* keep the placeholder; the loading view degrades to text */
    }
    const lang = resolveLang();
    const translated = translateUi(html, lang);
    // One line of evidence for "why is this still Chinese?" reports: which
    // language won and how much CJK survived (comments are expected to).
    const remaining = (translated.match(/[\u4e00-\u9fff]/g) ?? []).length;
    this.log(`panel html: lang=${lang}, ${remaining} CJK char(s) left`);
    return translated;
  }

  /** Re-send panel state after a setting it consumes from the state frame
   *  changes in VS Code Settings (arrow mode, attachment cap). Both the state
   *  frame and the targeted `config` push go out: the keydown handler must not
   *  depend on a full refresh arriving. */
  refreshConfig(): void {
    this.post({
      type: "config",
      promptArrowKeys: this.promptArrowMode(),
      maxAttachBytes: this.maxAttachBytes() ?? null,
        messageTimestamps: this.timestampsEnabled(),
    });
    this.postState();
  }

  /** Re-render the panel template after a language change (webview.html can only   *  be assigned wholesale, so the view is rebuilt; it re-requests state on load). */
  reloadLanguage(): void {
    if (!this.view) return;
    this.attachPanelHtml();
  }

  /* ---------- webview liveness watchdog ----------
   * VS Code's webview host can fail to register its service worker
   * (InvalidStateError) right after a cold start, leaving an iframe that never
   * runs our script — with no error the extension can observe. The panel posts
   * `panelReady` on every load, so silence is the signal.
   *
   * Re-assigning `webview.html` was tried and does NOT repair it: the failure is
   * in the webview host, not in the document. A fresh extension host does fix
   * it, so the remedy is a user-clicked Reload window — never an automated one,
   * which would discard every webview and every other extension's state. */
  private panelReady = false;
  private readyTimer?: ReturnType<typeof setTimeout>;
  /** One notification per load; cleared when the panel later signals ready. */
  private healNotified = false;

  /**
   * How long to wait for `panelReady` before assuming the webview is dead.
   *
   * The handshake is posted at the top of the panel script, before any
   * rendering, so it normally arrives in tens of milliseconds. One second is
   * already generous for a cold parse of the inlined bundle; going much lower
   * (or to zero) would fire on a slow load and cry wolf. There is no earlier
   * signal available: the service-worker failure happens inside VS Code's host
   * and is never reported to the extension.
   */
  private static readonly READY_TIMEOUT_MS = 1000;

  private deferTimer?: ReturnType<typeof setTimeout>;

  private attachPanelHtml(): void {
    if (!this.view) return;
    this.onPanelStarting(false);
    this.panelReady = false;
    this.healNotified = false;
    this.view.webview.html = this.renderHtml();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => this.reportDeadPanel(), NativePanelProvider.READY_TIMEOUT_MS);
  }

  /** Working panel → nothing happens; `panelReady` cancels the pending check. */
  private reportDeadPanel(): void {
    if (this.panelReady || this.healNotified || !this.view) return;
    this.healNotified = true;
    this.onPanelDead(true);
    // Measured: this follows a *fast restart*. Reload Window cannot clear it —
    // that restarts the extension host, while the failed service-worker
    // registration belongs to this process and survives until VS Code is fully
    // quit. The gap since the previous quit is the one useful diagnostic, so it
    // goes in the log and in the message the user sees.
    const gap = this.startupGapMs;
    const gapText =
      gap === undefined
        ? ""
        : gap < 20000
          ? tf("（本次 VS Code 是在上次退出后约 {0} 秒启动的——这是已知的触发条件）", Math.round(gap / 1000))
          : "";
    this.log(
      `panel silent for ${NativePanelProvider.READY_TIMEOUT_MS}ms — its webview never ran; only a full restart recovers this` +
        (gap === undefined ? "" : ` (started ${Math.round(gap / 1000)}s after the previous quit)`),
    );
    void vscode.commands.executeCommand("dsh.panelRecoveryInfo", gapText);
  }

  /* ---------- settings panel (editor-area tab, opened by the ⚙ button) ---------- */

  private settingsPanel?: vscode.WebviewPanel;

  /** Open (or reveal) the settings webview in the editor area — it behaves
   *  like a normal file tab, not another sidebar view. Reads/writes ride the
   *  settings domain (settings.describe / settings.mutate). */
  private openSettingsPanel(): void {
    if (this.settingsPanel) {
      this.settingsPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "dsh.settings",
      t("DSH 设置"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "media")],
      }
    );
    this.settingsPanel = panel;
    panel.onDidDispose(() => {
      this.settingsPanel = undefined;
    });
    const settingsPath = vscode.Uri.joinPath(this.context.extensionUri, "dist", "media", "native", "settings.html");
    panel.webview.html = translateUi(fs.readFileSync(settingsPath.fsPath, "utf8"), resolveLang());
    panel.webview.onDidReceiveMessage((msg) => {
      void this.onSettingsMessage(msg as Record<string, unknown>);
    });
  }

  /** This extension's own settings, shown first on the settings panel's General
   *  tab. They are local VS Code config, so they work with the harness down. */
  private postExtensionSettings(): void {
    const cfg = vscode.workspace.getConfiguration("dshVsc");
    try {
      void this.settingsPanel?.webview.postMessage({
        type: "settingsExtension",
        value: {
          language: cfg.get<string>("language", "auto"),
          promptArrowKeys: cfg.get<string>("promptArrowKeys", "history"),
        messageTimestamps: cfg.get<boolean>("messageTimestamps", true),
          maxAttachMB: cfg.get<number>("maxAttachMB", 50),
        },
      });
    } catch {
      /* panel disposed */
    }
  }

  private async setExtensionSetting(key: string, value: string | number | boolean): Promise<void> {
    const allowed: Record<string, "language" | "promptArrowKeys" | "messageTimestamps" | "maxAttachMB"> = {
      language: "language",
      promptArrowKeys: "promptArrowKeys",
      messageTimestamps: "messageTimestamps",
      maxAttachMB: "maxAttachMB",
    };
    const setting = allowed[key];
    if (!setting) {
      this.postSettingsError(`unknown setting: ${key}`);
      return;
    }
    try {
      await vscode.workspace.getConfiguration("dshVsc").update(setting, value, vscode.ConfigurationTarget.Global);
      this.log(`setting ${setting} = ${String(value)}`);
      // Push the value the panel acts on directly, not just via `state`: the
      // arrow mode is consumed in a keydown handler and must not lag a frame.
      this.post({
        type: "config",
        promptArrowKeys: this.promptArrowMode(),
        maxAttachBytes: this.maxAttachBytes() ?? null,
        messageTimestamps: this.timestampsEnabled(),
      });
      this.postExtensionSettings();
      this.postSettingsSaved(t("已保存"));
      // A language change re-renders the sidebar through the config listener in
      // extension.ts; a setting that the panel consumes in its state needs a
      // fresh state frame so the change is live without a reload.
      this.postState();
    } catch (error) {
      this.postSettingsError(describeHarnessFailure(t("保存失败"), error));
    }
  }

  private async onSettingsMessage(msg: Record<string, unknown>): Promise<void> {
    // Extension knobs are local: they must work even when the harness is down.
    if (msg.type === "settingsReady") {
      this.postExtensionSettings();
    } else if (msg.type === "setExtensionSetting") {
      await this.setExtensionSetting(String(msg.key ?? ""), msg.value as string | number | boolean);
      return;
    }
    if (!this.client) {
      this.postSettingsError(t("harness 未连接"));
      return;
    }
    switch (msg.type) {
      case "settingsReady":
        // Extension knobs first: they must render even when the harness is
        // reachable-but-slow, and they are the first thing a lost user needs.
        await this.postSettingsData();
        await this.postSettingsPresets();
        break;
      case "settingsMutate": {
        const ns = String(msg.ns ?? "");
        const ops = Array.isArray(msg.ops) ? (msg.ops as { op: string; path?: string[]; value?: unknown }[]) : [];
        const expectedRevision = typeof msg.expectedRevision === "number" ? msg.expectedRevision : undefined;
        try {
          await this.client.settingsMutate(
            ns,
            ops.map((o) =>
              o.op === "set"
                ? { op: "set" as const, path: o.path ?? [], value: o.value }
                : { op: "unset" as const, path: o.path ?? [] }
            ),
            expectedRevision
          );
          this.postSettingsSaved(t("已保存"));
          await this.postSettingsData();
        } catch (error) {
          this.postSettingsError(describeHarnessFailure(t("保存失败"), error));
        }
        break;
      }
    }
  }

  private async postSettingsData(): Promise<void> {
    if (!this.client) return;
    try {
      const value = await this.client.settingsDescribe();
      this.settingsPanel?.webview.postMessage({ type: "settingsData", value });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure(t("读取配置失败"), error));
    }
  }

  private async postSettingsPresets(): Promise<void> {
    if (!this.client) return;
    try {
      const value = await this.client.agentPresets();
      this.settingsPanel?.webview.postMessage({ type: "settingsAgentPresets", value });
    } catch (error) {
      this.postSettingsError(describeHarnessFailure(t("读取预设失败"), error));
    }
  }

  private postSettingsSaved(message: string): void {
    try {
      void this.settingsPanel?.webview.postMessage({ type: "settingsSaved", message });
    } catch {
      /* panel disposed */
    }
  }

  private postSettingsError(message: string): void {
    try {
      void this.settingsPanel?.webview.postMessage({ type: "settingsError", message });
    } catch {
      /* panel disposed */
    }
  }
}
