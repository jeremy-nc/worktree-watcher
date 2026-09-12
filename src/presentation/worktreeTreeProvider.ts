import * as os from 'node:os'
import * as vscode from 'vscode'

import { SessionTitleReader } from '../application/ports'
import { State, WorktreeStore } from '../application/worktreeStore'
import {
  compareWorktrees,
  repositoryDescription,
  tildify,
  worktreeDescription,
  worktreeLabel
} from '../domain/display'
import { Repository, Worktree } from '../domain/model'
import { Activity } from '../domain/activity'
import { BranchBuilds, buildSummary, buildTypeLabel } from '../domain/build'
import { isFinished, PullRequest, pullRequestSummary } from '../domain/pullRequest'

/** Looks up what a session is doing, if the feature is on. */
export interface ActivityLookup {
  find(sessionId: string): Activity | undefined
}

/** Looks up CI build status for a worktree branch, if the feature is on. */
export interface BuildLookup {
  find(repository: string, branch: string | undefined): BranchBuilds | undefined
}

/** Looks up the pull request for a worktree branch, if the feature is on. */
export interface PullRequestLookup {
  find(repository: string, branch: string | undefined): PullRequest | undefined
}

export type Node =
  | { readonly kind: 'repository'; readonly repository: Repository }
  | { readonly kind: 'worktree'; readonly repository: Repository; readonly worktree: Worktree }

/**
 * Thin mapping from domain objects onto TreeItem. All wording and ordering comes
 * from `domain/display`; this layer only decides icons, collapsibility and commands.
 */
export class WorktreeTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  private readonly home = os.homedir()

  constructor(
    private readonly store: WorktreeStore,
    private readonly titles: SessionTitleReader,
    private readonly pullRequests: PullRequestLookup,
    private readonly activities: ActivityLookup,
    private readonly builds: BuildLookup
  ) {
    this.store.onDidChange((state: State) => {
      if (state.status !== 'scanning') {
        this.changed.fire(undefined)
      }
    })
  }

  /** Redraw without rescanning — used when pull request status lands. */
  refresh(): void {
    this.changed.fire(undefined)
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === 'repository' ? this.repositoryItem(node) : this.worktreeItem(node)
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.store.current.repositories.map((repository) => ({ kind: 'repository', repository }))
    }
    if (node.kind === 'repository') {
      return [...node.repository.worktrees]
        .sort(compareWorktrees)
        .map((worktree) => ({ kind: 'worktree', repository: node.repository, worktree }))
    }
    return []
  }

  /**
   * Builds the hover tooltip. VS Code only calls this when `tooltip` was left
   * undefined, and only once per TreeItem — so titles refresh on the next scan,
   * while the session picker reads them live.
   */
  async resolveTreeItem(
    item: vscode.TreeItem,
    node: Node
  ): Promise<vscode.TreeItem> {
    if (node.kind !== 'worktree') {
      return item
    }
    const { worktree } = node

    const tooltip = new vscode.MarkdownString()
    tooltip.appendMarkdown(`**${worktreeLabel(worktree)}**\n\n`)
    tooltip.appendMarkdown(`\`${tildify(worktree.absolutePath, this.home)}\`\n\n`)
    tooltip.appendMarkdown(
      worktree.isMain ? '_Main checkout_' : `_Worktree of ${node.repository.name}_`
    )

    const pullRequest = worktree.isMain
      ? undefined
      : this.pullRequests.find(node.repository.name, worktree.branch)
    if (pullRequest) {
      tooltip.appendMarkdown(`\n\n**Pull request**\n\n`)
      tooltip.appendMarkdown(`[#${pullRequest.number} ${pullRequest.title}](${pullRequest.url})  \n`)
      const facts = [
        pullRequest.state,
        pullRequest.checks && `checks ${pullRequest.checks}`,
        pullRequest.review?.replace('-', ' ')
      ].filter(Boolean)
      tooltip.appendMarkdown(`${facts.join(' · ')}\n`)
      if (isFinished(pullRequest)) {
        tooltip.appendMarkdown(`\n_Nothing left to push — this worktree can probably go._\n`)
      }
    }

    const branchBuilds = worktree.isMain
      ? undefined
      : this.builds.find(node.repository.name, worktree.branch)
    if (branchBuilds) {
      tooltip.appendMarkdown(`\n\n**TeamCity**\n\n`)
      // Worst first, so a failure is the first thing read.
      for (const build of branchBuilds.builds.slice(0, 6)) {
        const mark = build.status === 'success' ? '✓' : build.status === 'failure' ? '✗' : '•'
        tooltip.appendMarkdown(`- ${mark} [${buildTypeLabel(build)}](${build.webUrl}) — ${build.status}\n`)
      }
      if (branchBuilds.builds.length > 6) {
        tooltip.appendMarkdown(`- …and ${branchBuilds.builds.length - 6} more\n`)
      }
    }

    // Computed on hover, so the elapsed time here is accurate when read.
    const activity = this.activityFor(worktree)
    if (activity) {
      const when = new Date(activity.at)
      tooltip.appendMarkdown(`\n\n**Activity**\n\n`)
      tooltip.appendMarkdown(
        `${activity.label} — ${when.toLocaleTimeString()} (${describeAge(Date.now() - activity.at)})\n`
      )
    }

    const sessions = worktree.claudeSessions
    if (sessions.length > 0) {
      const titles = await this.titles.titles(sessions.map((session) => session.id))
      const heading = sessions.length === 1 ? 'Claude session' : `${sessions.length} Claude sessions`
      tooltip.appendMarkdown(`\n\n**${heading}**\n\n`)

      for (const session of sessions.slice(0, 5)) {
        const title = titles.get(session.id)
        const when = session.at ? ` — ${session.at}` : ''
        tooltip.appendMarkdown(
          title
            ? `- **${title}**  \n  \`${session.id}\`${when}\n`
            : `- \`${session.id}\`${when}\n`
        )
      }
      if (sessions.length > 5) {
        tooltip.appendMarkdown(`- …and ${sessions.length - 5} more\n`)
      }
    }

    item.tooltip = tooltip
    return item
  }

  /** The most recent session's activity, which is the one worth showing. */
  private activityFor(worktree: Worktree): Activity | undefined {
    const latest = worktree.claudeSessions[0]
    return latest ? this.activities.find(latest.id) : undefined
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'worktree' ? { kind: 'repository', repository: node.repository } : undefined
  }

  private repositoryItem(node: Extract<Node, { kind: 'repository' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.repository.name,
      vscode.TreeItemCollapsibleState.Expanded
    )
    item.id = node.repository.worktreesPath
    item.description = repositoryDescription(node.repository)
    item.iconPath = new vscode.ThemeIcon('repo')
    item.contextValue = 'worktreeWatcher.repository'
    item.resourceUri = vscode.Uri.file(node.repository.worktreesPath)
    item.tooltip = new vscode.MarkdownString(
      `**${node.repository.name}**\n\n\`${tildify(node.repository.worktreesPath, this.home)}\``
    )
    return item
  }

  private worktreeItem(node: Extract<Node, { kind: 'worktree' }>): vscode.TreeItem {
    const { worktree } = node
    const item = new vscode.TreeItem(
      worktreeLabel(worktree),
      vscode.TreeItemCollapsibleState.None
    )
    item.id = worktree.absolutePath
    const pullRequest = worktree.isMain
      ? undefined
      : this.pullRequests.find(node.repository.name, worktree.branch)
    // The activity word alone, with no elapsed time: nothing re-renders on a
    // timer, so a duration here would freeze and start lying.
    const activity = this.activityFor(worktree)
    const branchBuilds = worktree.isMain
      ? undefined
      : this.builds.find(node.repository.name, worktree.branch)
    item.description = [
      worktreeDescription(worktree, this.home),
      pullRequest && pullRequestSummary(pullRequest),
      branchBuilds && buildSummary(branchBuilds),
      activity?.label
    ]
      .filter(Boolean)
      .join('  ·  ')
    item.resourceUri = vscode.Uri.file(worktree.absolutePath)
    item.iconPath = new vscode.ThemeIcon(
      worktree.isMain ? 'home' : worktree.branch ? 'git-branch' : 'git-commit',
      worktree.claudeSessions.length > 0 ? new vscode.ThemeColor('charts.purple') : undefined
    )
    // The `.claude` suffix is what reveals the resume action in the context menu.
    const base = worktree.isMain ? 'worktreeWatcher.mainCheckout' : 'worktreeWatcher.worktree'
    const claude = worktree.claudeSessions.length > 0 ? `${base}.claude` : base
    const withPr = pullRequest ? `${claude}.pr` : claude
    item.contextValue = branchBuilds ? `${withPr}.build` : withPr

    // Left undefined so VS Code calls resolveTreeItem on hover: session titles
    // need an async read, and this keeps it off the render path entirely.
    return item
  }
}

function describeAge(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) {
    return `${seconds}s ago`
  }
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}
