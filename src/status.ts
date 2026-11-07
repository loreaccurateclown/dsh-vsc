// 底部状态栏指示器
import * as vscode from "vscode";
import { t } from "./i18n";

/**
 * Left status bar indicator: harness state; click opens the sidebar / review.
 *
 * It also doubles as the only always-visible affordance when the panel's
 * webview never starts: the panel cannot render an error of its own, so the
 * dead state is an *overlay* here — it wins over whatever the harness state
 * says, and reverts to it once the panel answers again.
 */
export class DshStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private baseText = "";
  private baseTooltip: string | vscode.MarkdownString | undefined = "";
  private baseCommand: string | vscode.Command | undefined;
  private panelDead = false;
  private panelStarting = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.show();
    this.setSearching();
  }

  private setBase(text: string, tooltip: string, command: string): void {
    this.baseText = text;
    this.baseTooltip = tooltip;
    this.baseCommand = command;
    this.apply();
  }

  private apply(): void {
    if (this.panelDead) {
      this.item.text = "$(warning) " + t("DSH: 面板未加载 — 需重启 VS Code");
      this.item.tooltip = t(
        "DSH 面板的 webview 没有启动（VS Code service worker 注册失败）。重新加载窗口无法修复，必须完全退出并重新启动 VS Code。点击可退出。",
      );
      // Opens the recovery notification rather than quitting: a status-bar click
      // is easy to misfire, and the choice belongs in a dialog with the
      // consequences spelled out.
      this.item.command = "dsh.panelRecoveryInfo";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      return;
    }
    if (this.panelStarting) {
      // Deliberately NOT in the webview: painting anything there would create
      // the document we are waiting to create.
      this.item.text = "$(sync~spin) " + t("DSH: 面板启动中…");
      this.item.tooltip = t("正在等待编辑器启动完成，随后加载 DSH 面板（避免 webview 的已知启动竞态）。");
      this.item.command = "dsh.openSidebar";
      this.item.backgroundColor = undefined;
      return;
    }
    this.item.text = this.baseText;
    this.item.tooltip = this.baseTooltip;
    this.item.command = this.baseCommand;
    this.item.backgroundColor = undefined;
  }

  /** The panel's first paint is being held back while the editor starts up. */
  setPanelStarting(starting: boolean): void {
    if (this.panelStarting === starting) return;
    this.panelStarting = starting;
    this.apply();
  }

  /** The panel's script never signalled ready: make that impossible to miss. */
  setPanelDead(): void {
    this.panelDead = true;
    this.apply();
  }

  clearPanelDead(): void {
    if (!this.panelDead) return;
    this.panelDead = false;
    this.apply();
  }

  setSearching(): void {
    this.setBase("$(sync~spin) DSH…", "DSH Bridge: probing harness…", "dsh.openSidebar");
  }

  setStarting(port: number): void {
    this.setBase("$(sync~spin) DSH starting…", `DSH Bridge: starting dsh web on :${port}`, "dsh.openSidebar");
  }

  setOnline(version: string): void {
    this.setBase("$(vm-active) DSH", `DSH Bridge: connected (harness ${version}) — click to open sidebar`, "dsh.openSidebar");
  }

  setOffline(): void {
    this.setBase("$(vm-outline) DSH offline", "DSH Bridge: no harness reachable — click to open sidebar", "dsh.openSidebar");
  }

  setChanges(count: number): void {
    this.setBase(t(`$(diff) DSH: ${count} 个文件改动`), t("DSH Bridge: agent 改动了文件 — 点击审查"), "dsh.reviewChanges");
  }

  dispose(): void {
    this.item.dispose();
  }
}
