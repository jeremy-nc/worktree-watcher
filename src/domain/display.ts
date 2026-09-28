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

/** Characters of session title shown ahead of the branch; 0 hides it. */
export const DEFAULT_SESSION_TITLE_LENGTH = 28

/**
 * `Create always-visible VSCod… feature/ABC-123` — the session's title leading,
 * cut to `maxLength`, then the branch.
 *
 * The title goes first because it says what the work *is*, which a branch name
 * like `dependabot/gradle/minor-and-patch-8e69e0ae7a` does not; truncating keeps
 * the branch in view however long the title runs. Two spaces separate them,
 * since an untruncated title has no ellipsis to mark where it ends.
 */
export function labelWithSession(
  label: string,
  title: string | undefined,
  maxLength: number
): string {
  const shown = title ? truncate(title, maxLength) : ''
  return shown ? `${shown}  ${label}` : label
}

/**
 * Cuts to `maxLength` characters including a trailing `…`.
 *
 * Counts code points rather than UTF-16 units, so an emoji in a title is never
 * split into a broken half. Runs of whitespace collapse first, so a title with
 * a line break in it does not produce a gap.
 */
export function truncate(text: string, maxLength: number): string {
  const characters = [...text.replace(/\s+/g, ' ').trim()]
  if (maxLength <= 0) {
    return ''
  }
  if (characters.length <= maxLength) {
    return characters.join('')
  }
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join('').trimEnd()}…`
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
