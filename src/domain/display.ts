/**
 * Display policy. Decides what text appears for a repository or worktree, with no
 * knowledge of how it will be rendered — so the rules are unit-testable and the
 * presentation layer stays a thin mapping onto TreeItem.
 */
import { Repository, Worktree } from './model'

export function worktreeLabel(worktree: Worktree): string {
  if (worktree.branch) {
    return worktree.branch
  }
  if (worktree.detachedHead) {
    return `detached at ${worktree.detachedHead.slice(0, 7)}`
  }
  return worktree.folderPath
}

/**
 * The dimmed right-hand text.
 *
 * For a worktree this is the on-disk folder, shown *only when it differs from the
 * branch* — that divergence is the thing worth surfacing, and showing it always
 * would be noise for the majority that match.
 */
export function worktreeDescription(worktree: Worktree, homePath: string): string | undefined {
  if (worktree.isMain) {
    return tildify(worktree.absolutePath, homePath)
  }
  return worktree.branch && worktree.folderPath !== worktree.branch ? worktree.folderPath : undefined
}

export function repositoryDescription(repository: Repository): string | undefined {
  const count = repository.worktrees.filter((worktree) => !worktree.isMain).length
  if (count === 0) {
    return 'no worktrees'
  }
  return count === 1 ? '1 worktree' : `${count} worktrees`
}

/** Main checkout first, then branches alphabetically. */
export function compareWorktrees(a: Worktree, b: Worktree): number {
  if (a.isMain !== b.isMain) {
    return a.isMain ? -1 : 1
  }
  return worktreeLabel(a).localeCompare(worktreeLabel(b), undefined, { sensitivity: 'base' })
}

export function compareRepositories(a: Repository, b: Repository): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export function tildify(absolutePath: string, homePath: string): string {
  if (homePath.length > 0 && absolutePath.startsWith(homePath)) {
    return `~${absolutePath.slice(homePath.length)}`
  }
  return absolutePath
}
