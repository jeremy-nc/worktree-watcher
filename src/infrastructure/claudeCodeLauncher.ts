import * as path from 'node:path'
import * as vscode from 'vscode'

import { Logger } from '../application/ports'
import { isFolderOpen } from '../domain/handoff'
import { ClaudeTranscriptVerifier } from './claudeTranscriptVerifier'
import { PendingSessionStore } from './pendingSessionStore'

/** Command the Claude Code extension's own URI handler forwards `/open` to. */
const OPEN_SESSION_COMMAND = 'claude-vscode.primaryEditor.open'

/** How long to wait for the Claude Code extension to finish activating. */
const CLAUDE_READY_TIMEOUT_MS = 30_000
const CLAUDE_POLL_INTERVAL_MS = 400

/**
 * How long to keep looking for a restoring tab before opening a new one.
 *
 * A window that has just started restores its editors asynchronously, so a Claude
 * tab for the session may not be in `tabGroups` — or may not have its title yet —
 * at the moment this runs. Opening immediately is what produces a duplicate.
 */
const TAB_SETTLE_TIMEOUT_MS = 8_000
const TAB_POLL_INTERVAL_MS = 500

/** Webview view type of a Claude Code conversation tab. */
const CLAUDE_PANEL_VIEW_TYPE = 'claudeVSCodePanel'

/** `openEditorAtIndex` acts on the active group, so the group is focused first. */
const GROUP_FOCUS_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup'
]

/**
 * Opens a recorded Claude session in the Claude Code extension.
 *
 * Two paths, because a session belongs to a folder:
 *
 * - The worktree is already open here → focus or open the session directly.
 * - It is not → park the request on disk, open the folder, and let the window
 *   that lands on it claim the request as it activates.
 *
 * The handoff avoids `vscode://Anthropic.claude-code/open?session=…`, which is
 * the documented-by-behaviour route from *outside* VS Code but cannot target a
 * particular window — VS Code delivers a URI to whichever window is active, so
 * using it here would race with the new window taking focus.
 */
export class ClaudeCodeLauncher {
  constructor(
    private readonly transcripts: ClaudeTranscriptVerifier,
    private readonly pending: PendingSessionStore,
    private readonly logger: Logger
  ) {}

  async open(sessionId: string, worktreePath: string): Promise<void> {
    // Open where the session actually ran, which is not always the worktree it is
    // listed against — the worktree path is only a fallback.
    const recorded = await this.transcripts.workingDirectory(sessionId)
    const target = recorded ?? worktreePath
    if (recorded && recorded !== worktreePath) {
      this.logger.info(`session ${sessionId} ran in ${recorded}, not ${worktreePath}`)
    }

    return this.openIn(sessionId, target)
  }

  private async openIn(sessionId: string, worktreePath: string): Promise<void> {
    this.logger.info(`open ${sessionId} for ${worktreePath}`)
    if (isFolderOpen(worktreePath, workspacePaths())) {
      await this.openHere(sessionId, worktreePath, 0)
      return
    }
    this.logger.info(`worktree not open here (${workspacePaths().join(', ') || 'no folders'}); parking request`)

    // The worktree is not open in this window. Park the request, open the
    // folder, and let the window that lands on it pick the request up.
    await this.pending.write({ sessionId, worktreePath, requestedAt: Date.now() })
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
      forceNewWindow: true
    })
  }

  /**
   * Called on activation. If this window is the one a pending request was aimed
   * at, claim it and open the session.
   */
  async consumePending(): Promise<void> {
    const pending = await this.pending.claim(workspacePaths(), Date.now())
    if (!pending) {
      return
    }
    this.logger.info(`claimed pending session ${pending.sessionId}`)
    // This window is still restoring, so give its tabs time to appear.
    await this.openHere(pending.sessionId, pending.worktreePath, TAB_SETTLE_TIMEOUT_MS)
  }

  /** Opens (or focuses) a session whose worktree is open in this window. */
  private async openHere(
    sessionId: string,
    worktreePath: string,
    settleMs: number
  ): Promise<void> {
    // A freshly started window activates this extension alongside Claude Code,
    // so the command may not exist yet. Waiting beats silently dropping the
    // request, which is what checking once would do.
    if (!(await this.waitForClaudeCode())) {
      const choice = await vscode.window.showWarningMessage(
        'Claude Code did not become available, so the session could not be opened.',
        'Resume in Terminal'
      )
      if (choice) {
        resumeInTerminal(sessionId, worktreePath)
      }
      return
    }

    const title = await this.transcripts.title(sessionId)
    this.logger.info(`tab title for session: ${title ?? '<none yet>'}`)

    const deadline = Date.now() + settleMs
    do {
      if (title && (await this.focusExistingTab(title))) {
        this.logger.info('focused an existing tab')
        return
      }
      if (Date.now() < deadline) {
        await delay(TAB_POLL_INTERVAL_MS)
      }
    } while (Date.now() < deadline)

    this.logger.info(`no existing tab found (${describeTabs()}); opening a new one`)
    await vscode.commands.executeCommand(OPEN_SESSION_COMMAND, sessionId)
  }

  private async waitForClaudeCode(): Promise<boolean> {
    const deadline = Date.now() + CLAUDE_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.claudeCodeAvailable()) {
        return true
      }
      await delay(CLAUDE_POLL_INTERVAL_MS)
    }
    return false
  }

  /**
   * Focuses an already-open tab for this session, returning false if there isn't
   * one (or it could not be focused, in which case opening normally is correct).
   *
   * Claude Code does dedupe by session — `createPanel` reveals an existing panel
   * from its `sessionPanels` map. But a panel restored after a window reload is
   * deserialized with no session id and only re-registers once its webview loads
   * and reports one, so a background tab is invisible to that map and a second
   * tab appears. This closes that window.
   *
   * The VS Code tab API exposes a tab's label but not which session it holds, so
   * the match is on the transcript's `ai-title` — which is exactly what the tab
   * is labelled.
   */
  private async focusExistingTab(title: string): Promise<boolean> {
    for (const group of vscode.window.tabGroups.all) {
      const index = group.tabs.findIndex((tab) => isClaudeTab(tab) && tab.label === title)
      if (index < 0) {
        continue
      }

      const tab = group.tabs[index]
      if (tab.isActive && group.isActive) {
        return true
      }

      const focusGroup = GROUP_FOCUS_COMMANDS[(group.viewColumn ?? 1) - 1]
      if (!focusGroup) {
        return false
      }

      try {
        await vscode.commands.executeCommand(focusGroup)
        // 0-based: VS Code registers openEditorAtIndex1 with index 0.
        await vscode.commands.executeCommand('workbench.action.openEditorAtIndex', index)
      } catch {
        return false
      }

      // Verify rather than assume — falling back to opening is better than
      // silently focusing nothing.
      return vscode.window.tabGroups.activeTabGroup.activeTab?.label === title
    }

    return false
  }

  private async claudeCodeAvailable(): Promise<boolean> {
    return (await vscode.commands.getCommands(true)).includes(OPEN_SESSION_COMMAND)
  }
}

function isClaudeTab(tab: vscode.Tab): boolean {
  return (
    tab.input instanceof vscode.TabInputWebview &&
    tab.input.viewType.includes(CLAUDE_PANEL_VIEW_TYPE)
  )
}

/** Opens a terminal in the worktree and resumes the session through the CLI. */
export function resumeInTerminal(sessionId: string, worktreePath: string): void {
  const terminal = vscode.window.createTerminal({
    name: `claude · ${path.basename(worktreePath)}`,
    cwd: worktreePath
  })
  terminal.show()
  terminal.sendText(`claude --resume ${sessionId}`)
}

/** Claude tabs currently open, for diagnosing a duplicate. */
function describeTabs(): string {
  const labels = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(isClaudeTab).map((tab) => tab.label)
  )
  return labels.length ? `claude tabs: ${labels.join(' | ')}` : 'no claude tabs open'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath)
}
