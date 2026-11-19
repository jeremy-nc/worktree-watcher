/**
 * Which worktrees the panel lists. Pure — the chosen filter and the pull
 * request lookup are passed in.
 */

import { Repository, Worktree } from './model'
import { PullRequest } from './pullRequest'

export type WorktreeFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'open-pull-requests' }
  | { readonly kind: 'session'; readonly sessionId: string; readonly title?: string }

export const SHOW_ALL: WorktreeFilter = { kind: 'all' }

/**
 * Whether a worktree row passes the filter.
 *
 * Open pull requests: the main checkout always passes, since it never has a
 * pull request of its own and anchors each repository; drafts do not count as
 * open, and a branch with no pull request yet is hidden with merged and closed.
 *
 * Session: only worktrees that recorded the session, which the main checkout
 * never does.
 */
export function passesFilter(
  filter: WorktreeFilter,
  worktree: Worktree,
  pullRequest: PullRequest | undefined
): boolean {
  switch (filter.kind) {
    case 'all':
      return true
    case 'open-pull-requests':
      return worktree.isMain || pullRequest?.state === 'open'
    case 'session':
      return worktree.claudeSessions.some((session) => session.id === filter.sessionId)
  }
}

/**
 * Whether a repository row shows at all.
 *
 * The open filter narrows a tree whose shape you know, so every repository
 * stays. The session filter answers where a session worked, so repositories it
 * never touched would be noise.
 */
export function showsRepository(filter: WorktreeFilter, repository: Repository): boolean {
  return (
    filter.kind !== 'session' ||
    repository.worktrees.some((worktree) => passesFilter(filter, worktree, undefined))
  )
}

/** The view's title text while a filter is on; nothing when it is not. */
export function filterDescription(filter: WorktreeFilter): string | undefined {
  switch (filter.kind) {
    case 'all':
      return undefined
    case 'open-pull-requests':
      return 'open pull requests'
    case 'session':
      return `session: ${filter.title ?? filter.sessionId.slice(0, 8)}`
  }
}

/**
 * Reads a filter back from workspace state. Earlier versions stored the two
 * original kinds as bare strings, which still read; anything else is no filter.
 */
export function parseFilter(stored: unknown): WorktreeFilter {
  if (stored === 'open-pull-requests') {
    return { kind: 'open-pull-requests' }
  }
  if (typeof stored !== 'object' || stored === null) {
    return SHOW_ALL
  }
  const candidate = stored as Partial<{ kind: string; sessionId: string; title: string }>
  if (candidate.kind === 'open-pull-requests') {
    return { kind: 'open-pull-requests' }
  }
  if (candidate.kind === 'session' && typeof candidate.sessionId === 'string') {
    return {
      kind: 'session',
      sessionId: candidate.sessionId,
      ...(typeof candidate.title === 'string' && { title: candidate.title })
    }
  }
  return SHOW_ALL
}

export interface SessionAcross {
  readonly id: string
  /** The most recent time any worktree recorded it. */
  readonly at?: string
  readonly worktrees: number
}

/**
 * Every session recorded anywhere in the tree, most recent first, with how
 * many worktrees each touched. The list the session filter is chosen from.
 */
export function sessionsAcross(repositories: readonly Repository[]): SessionAcross[] {
  const found = new Map<string, { at?: string; worktrees: number }>()
  for (const repository of repositories) {
    for (const worktree of repository.worktrees) {
      for (const session of worktree.claudeSessions) {
        const existing = found.get(session.id)
        found.set(session.id, {
          at: latest(existing?.at, session.at),
          worktrees: (existing?.worktrees ?? 0) + 1
        })
      }
    }
  }
  return [...found]
    .map(([id, entry]) => ({ id, at: entry.at, worktrees: entry.worktrees }))
    .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) {
    return b
  }
  if (b === undefined) {
    return a
  }
  return a > b ? a : b
}
