/**
 * Native sidebar panel — webview ↔ extension-host message protocol.
 * The panel is plain JS (inline in panel.html); these types drive the host side.
 */

/** A raw session event forwarded to the panel (wire passthrough). */
export interface PanelEvent {
  type: string;
  seq?: number;
  /** Unix epoch ms stamped by the harness on every durable log entry. */
  time?: number;
  data?: Record<string, unknown>;
  surfaceOp?: string;
  /** Envelope rpcId of a server-request frame (approval/question answerable frames). */
  rpcId?: string;
}

/** One bridge-computed line diff for a tool call ("+N-M"). */
export interface ToolLineDiff {
  added: number;
  deleted: number;
  /** Resolved absolute path (when resolvable) or the raw tool argument. */
  path?: string;
}

/** One todo item — the `todos` projection unit (dsh-tool-todo / dsh-session types). */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** Host → webview messages. */
export type HostMessage =
  | {
      type: "state";
      connected: boolean;
      version?: string;
      phase?: "searching" | "starting" | "online" | "offline";
      sessions: PanelSession[];
      /**
       * Workspace rows from `workspace/follow`, in host order. The picker uses
       * this to group sessions exactly like the official web GUI, including
       * sessions that belong to no workspace ("Ungrouped").
       */
      workspaces?: { workspaceId: string; title: string; path: string }[];
      /** Byte cap the panel applies before reading a dropped or pasted file.
       *  `null` (or absent) means the limit is disabled. */
      maxAttachBytes?: number | null;
      /** Composer arrow behaviour: `history` = terminal Up/Down, `caret` = editor. */
      promptArrowKeys?: "history" | "caret";
      /** Show times in the transcript (user messages + turn labels). */
      messageTimestamps?: boolean;
      activeSessionId: string | null;
    }
  | { type: "event"; sessionId: string; event: PanelEvent }
  | { type: "history"; sessionId: string; events: PanelEvent[]; hasMore: boolean; isOlder?: boolean; toolDiffs?: Record<string, ToolLineDiff> }
  | { type: "running"; sessionId: string; running: boolean }
  | { type: "pickedFile"; path: string }
  | { type: "index"; files: string[]; dirs: string[] }
  | {
      type: "models";
      current?: { provider: string; model: string; reasoningEffort?: string };
      groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[];
    }
  | { type: "queue"; sessionId: string; items: { id: string; placement: string; text: string }[] }
  | { type: "commands"; items: { name: string; description?: string; input?: { hint?: string; images?: boolean } }[] }
  | { type: "cmdResult"; text: string; ok: boolean }
  | { type: "todos"; sessionId: string; items: TodoItem[] }
  | { type: "toolDiff"; sessionId: string; callId: string; added: number; deleted: number; path?: string }
  | {
      type: "ask";
      /** Structured editor-context block (file / selection / workspace). */
      context: string;
      /** Choice buttons rendered inside the panel (id === "custom" gets an input box). */
      choices: { id: string; label: string; detail?: string }[];
    }
  | {
      type: "interaction";
      sessionId: string;
      /** rpcId to echo when answering via /api/respond. */
      rpcId: string;
      kind: "approval";
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    }
  | {
      type: "interaction";
      sessionId: string;
      rpcId: string;
      kind: "question";
      questions: {
        id: string;
        question: string;
        detail?: string;
        header?: string;
        multiSelect?: boolean;
        options?: { label: string; description?: string }[];
        intent?: { kind: "plan-review"; approve: string } | { kind: string; approve: string };
      }[];
    }
  | { type: "interactionSettled"; sessionId: string; rpcId: string }
  | {
      type: "permissions";
      options: { value: string; label: string }[];
      current?: string;
    }
  | {
      type: "agentPresets";
      /** Agent-preset roster for the new-session mode picker (id → display copy). */
      presets: { id: string; name?: string; description?: string; isDefault?: boolean }[];
    }
  | { type: "error"; message: string }
  | {
      /** Targeted config push for values the panel reads on input events.
       *  Delivered on its own so a stuck state frame cannot leave the composer
       *  on a stale arrow mode. */
      type: "config";
      promptArrowKeys: "history" | "caret";
      maxAttachBytes: number | null;
      messageTimestamps: boolean;
    }
  | {
      /** Resolution of an async clipboard write; `ok=false` carries the reason. */
      type: "copyResult";
      ok: boolean;
      message: string;
    }
  | {
      /**
       * Live metrics for the active session, pushed the moment the matching
       * projection frames land. The status line used to depend on a full
       * session-list refresh, so it went blank between refreshes.
       */
      type: "sessionMetrics";
      sessionId: string;
      usage?: PanelSession["usage"];
      stats?: PanelSession["stats"];
      context?: PanelSession["context"];
    }
  | {
      /**
       * The outcome of a `copyText` write done by the extension host. The
       * panel's own clipboard write is unobservable, so every copy is confirmed
       * here instead of assumed.
       */
      type: "copyResult";
      requestId: string;
      ok: boolean;
      error?: string;
    }
  | {
      /** One resolved transcript image (session.attachment round-trip). */
      type: "attachment";
      requestId: number;
      attachmentId: string;
      mediaType?: string;
      /** base64 payload; absent when `error` is set. */
      data?: string;
      width?: number;
      height?: number;
      bytes?: number;
      name?: string;
      error?: string;
    }
  | {
      /** One local image the assistant linked by path, as a data: URL. */
      type: "imageData";
      requestId: number;
      mediaType?: string;
      /** base64 payload; absent when `error` is set. */
      data?: string;
      error?: string;
      /** The requester wanted bytes for the composer rail, not an <img>. */
      attach?: boolean;
    }
  | {
      /**
       * A clipboard image read on the panel's behalf. A webview paste event
       * normally carries no OS image item (`clipboardData.items` holds text
       * only), so the panel asks the host for the bytes; the host uses the
       * platform's clipboard tooling (`src/panel/clipboard.ts`).
       */
      type: "clipboardImage";
      requestId: number;
      mediaType?: string;
      /** base64 payload; absent when `error` is set. */
      data?: string;
      error?: string;
    };

/** Webview → host messages. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string }
  | { type: "newSession"; agentPreset?: string }
  | { type: "getAgentPresets" }
  | { type: "deleteSession"; sessionId: string }
  | { type: "send"; text: string; mode?: "queue" | "steer"; attachments?: { mediaType: string; data: string; name?: string }[] }
  | { type: "loadOlder"; beforeSeq: number }
  | { type: "cancel" }
  | { type: "refresh" }
  | { type: "refreshFiles" }
  | { type: "getModels" }
  | { type: "selectModel"; provider: string; model: string; reasoningEffort?: string }
  | { type: "copyText"; text: string; requestId?: string }
  | {
      /** The panel script is alive and has run its init. The host uses this as a
       *  liveness handshake: no `panelReady` after a load means the webview is
       *  broken (VS Code's service-worker bug) and gets retried. */
      type: "panelReady";
    }
  | { type: "panelLog"; text: string }
  | { type: "readClipboardImage"; requestId: number }
  | {
      /** Put an image on the OS clipboard. The webview cannot: its native Copy
       *  command copies the DOM selection as text, never image bytes. */
      type: "copyImage";
      mediaType: string;
      /** base64 payload without the `data:` prefix. */
      data: string;
    }
  | { type: "openFile"; path: string }
  | { type: "queueSteer"; itemId: string }
  | { type: "queueRemove"; itemId: string }
  | { type: "askPick"; choiceId: string; customText?: string }
  | { type: "askCancel" }
  | {
      type: "respondApproval";
      rpcId: string;
      sessionId: string;
      approvalId: string;
      outcome: "allowed-once" | "rejected";
    }
  | {
      type: "respondQuestion";
      rpcId: string;
      sessionId: string;
      answers: { id: string; selected: string[]; custom?: string }[];
    }
  | { type: "getPermissions" }
  | { type: "selectPermission"; permission: string }
  | { type: "openExternal"; url: string }
  | {
      /** Lazy fetch of one logged image's bytes (harness session.attachment). */
      type: "getAttachment";
      requestId: number;
      sessionId: string;
      attachmentId: string;
    }
  | {
      /** Lazy read of one local image the assistant referenced by path
       *  (`![alt](D:\out\shot.png)`) — paths never load inside the webview. */
      type: "readImage";
      requestId: number;
      path: string;
      /** Attach the bytes to the composer instead of filling an <img>. */
      attach?: boolean;
    }
  | { type: "openSettings" };

export interface PanelSession {
  sessionId: string;
  running: boolean;
  blank: boolean;
  updatedAt: number;
  title?: string;
  /**
   * Workspace directory the session belongs to. The upstream panel dropped this
   * from `SessionSummary`; the picker uses it to group sessions by folder.
   */
  cwd?: string;
  /** Workspace the session belongs to (absent = the web GUI's "Ungrouped"). */
  workspaceId?: string;
  /** Current agent preset of the session (agentPreset.list/select domain). */
  agentPreset?: string;
  /** tokenUsage projection (aggregate over the durable log). */
  usage?: {
    uncachedInputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    /**
     * DSH 0.2.1 nests the durable counters here and keeps the current turn's
     * counters under `last`; 0.1.x served them flat on the projection itself.
     */
    totals?: {
      uncachedInputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      outputTokens?: number;
    };
  };
  /** sessionStats projection — the web composer's status line source. */
  stats?: {
    turns?: number;
    steps?: number;
    llmMs?: number;
    toolMs?: number;
    ttftMs?: number;
    ttftSteps?: number;
    decodeMs?: number;
    decodeTokens?: number;
  };
  /** contextPressure projection — context occupancy ring source. */
  context?: {
    projectedTokens?: number;
    pressureTokens?: number;
    contextWindow?: number;
  };
}
