/**
 * Rules for removing a worktree. Pure — decides what the user is told and what
 * is offered, with no knowledge of git or VS Code.
 *
 * What git does on its own, and therefore what this must add:
 *
 * - Uncommitted or untracked files → `git worktree remove` **refuses**. That
 *   safety net is inherited, so it is never pre-empted with `--force`.
 * - Unpushed commits → git removes **silently**. Nothing warns you, so this does.
 * - The branch → **always survives** removal, which is how orphaned local refs
 *   accumulate. Deleting it is offered only when it is demonstrably safe.
 */
import { PullRequest, pullRequestSummary } from './pullRequest'
import { tildify } from './display'

export interface WorktreeStatus {
  readonly dirtyFiles: number
  readonly unpushedCommits: number
}

export interface RemovalPlan {
  readonly title: string
  readonly detail: string
  /** True when the branch is merged and holds nothing unpushed. */
  readonly canDeleteBranch: boolean
  /** True when removal could strand work; the dialog leans on this. */
  readonly risky: boolean
}

export interface RemovalContext {
  readonly label: string
  readonly absolutePath: string
  readonly branch?: string
  readonly pullRequest?: PullRequest
  readonly status: WorktreeStatus
  readonly homePath: string
}

export function planRemoval(context: RemovalContext): RemovalPlan {
  const { pullRequest, status } = context

  const facts: string[] = [
    pullRequest ? `PR ${pullRequestSummary(pullRequest)}` : 'No pull request',
    status.dirtyFiles > 0
      ? `${count(status.dirtyFiles, 'uncommitted change')}`
      : 'working tree clean'
  ]
  if (status.unpushedCommits > 0) {
    facts.push(count(status.unpushedCommits, 'unpushed commit'))
  }

  const lines = [tildify(context.absolutePath, context.homePath), facts.join(' · ')]

  if (status.unpushedCommits > 0) {
    lines.push('', 'The branch is kept, but those commits will only exist on it.')
  }
  if (status.dirtyFiles > 0) {
    lines.push('', 'Git will refuse while there are uncommitted changes.')
  }

  return {
    title: `Remove worktree “${context.label}”?`,
    detail: lines.join('\n'),
    canDeleteBranch:
      Boolean(context.branch) &&
      pullRequest?.state === 'merged' &&
      status.unpushedCommits === 0,
    risky: status.unpushedCommits > 0 || !pullRequest
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}
