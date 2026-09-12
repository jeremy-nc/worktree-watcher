/**
 * Rules for bulk-removing worktrees that have gone stale. Pure — no git, no
 * filesystem, no VS Code.
 *
 * Bulk removal is a different risk from removing one worktree by hand, so the
 * rules here are deliberately more cautious than {@link ./removal.ts}:
 *
 * - **Age is the newest signal, not the oldest.** A worktree counts as recently
 *   active if *either* its last commit or its directory mtime is recent. Taking
 *   the newer of the two means uncommitted work in progress reads as active and
 *   is never offered up.
 * - **Only demonstrably safe worktrees are pre-selected.** Anything dirty or
 *   holding unpushed commits is listed, but unticked — you opt into that.
 * - **Nothing is hidden.** A stale worktree git would refuse to remove still
 *   appears, with the reason, rather than silently vanishing from the list.
 */
import { PullRequest, pullRequestSummary } from './pullRequest'
import { WorktreeStatus } from './removal'
import { Worktree } from './model'

export const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/** Default staleness threshold, overridable in settings. */
export const DEFAULT_STALE_DAYS = 14

/** What is known about one worktree when deciding whether to offer it. */
export interface CleanUpInput {
  readonly worktree: Worktree
  /** Commit date of HEAD, epoch ms. Undefined when it could not be read. */
  readonly lastCommitAt?: number
  /** Directory mtime, epoch ms. Undefined when it could not be read. */
  readonly directoryModifiedAt?: number
  readonly status: WorktreeStatus
  readonly pullRequest?: PullRequest
}

export interface CleanUpCandidate {
  readonly worktree: Worktree
  readonly lastActivityAt: number
  readonly ageDays: number
  readonly status: WorktreeStatus
  readonly pullRequest?: PullRequest
  /**
   * Clean and fully pushed, so removal cannot strand work. Only these start
   * ticked; everything else is an explicit choice.
   */
  readonly safe: boolean
  /** Why this one is not safe, for the list. Undefined when it is. */
  readonly warning?: string
}

/**
 * When this worktree was last worked in.
 *
 * The **newer** of the two signals wins, because each misses a different kind of
 * activity: committing does not necessarily touch the worktree root's mtime, and
 * editing files without committing does not move HEAD. Treating the newer one as
 * the truth errs toward calling a worktree active.
 */
export function lastActivity(input: CleanUpInput): number | undefined {
  const signals = [input.lastCommitAt, input.directoryModifiedAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  )
  return signals.length > 0 ? Math.max(...signals) : undefined
}

/**
 * Stale worktrees, oldest first.
 *
 * The main checkout is never a candidate — it is the repository, not a worktree.
 * Neither is one whose age cannot be established: an unknown age is not an old
 * age, and guessing in a delete flow is how you lose work.
 */
export function selectStale(
  inputs: readonly CleanUpInput[],
  options: { readonly now: number; readonly staleDays: number }
): CleanUpCandidate[] {
  const cutoff = options.now - options.staleDays * MILLISECONDS_PER_DAY

  const candidates: CleanUpCandidate[] = []
  for (const input of inputs) {
    if (input.worktree.isMain) {
      continue
    }
    const at = lastActivity(input)
    if (at === undefined || at > cutoff) {
      continue
    }

    const warning = warn(input.status)
    candidates.push({
      worktree: input.worktree,
      lastActivityAt: at,
      ageDays: Math.floor((options.now - at) / MILLISECONDS_PER_DAY),
      status: input.status,
      pullRequest: input.pullRequest,
      safe: warning === undefined,
      warning
    })
  }

  return candidates.sort((a, b) => a.lastActivityAt - b.lastActivityAt)
}

/**
 * Why a worktree should not be removed without a second thought.
 *
 * Dirty comes first: git refuses outright, so it is the more useful thing to
 * read when both are true.
 */
function warn(status: WorktreeStatus): string | undefined {
  if (status.dirtyFiles > 0) {
    return `${count(status.dirtyFiles, 'uncommitted change')} — git will refuse`
  }
  if (status.unpushedCommits > 0) {
    return `${count(status.unpushedCommits, 'unpushed commit')}`
  }
  return undefined
}

/** Right-hand text in the list: how old, and the PR if there is one. */
export function candidateDescription(candidate: CleanUpCandidate): string {
  const parts = [describeAge(candidate.ageDays)]
  if (candidate.pullRequest) {
    parts.push(`PR ${pullRequestSummary(candidate.pullRequest)}`)
  }
  return parts.join('  ·  ')
}

export function describeAge(ageDays: number): string {
  if (ageDays >= 365) {
    const years = Math.floor(ageDays / 365)
    return `${count(years, 'year')} idle`
  }
  if (ageDays >= 60) {
    return `${count(Math.floor(ageDays / 30), 'month')} idle`
  }
  return `${count(ageDays, 'day')} idle`
}

export interface CleanUpConfirmation {
  readonly title: string
  readonly detail: string
  /** True when the selection includes something that could strand work. */
  readonly risky: boolean
}

/**
 * The confirmation shown before anything is removed.
 *
 * It names what is at stake rather than repeating the list: the user has just
 * ticked those boxes, so the useful information is the total, the branches that
 * survive, and anything that will refuse.
 */
export function confirmCleanUp(
  repositoryName: string,
  selected: readonly CleanUpCandidate[]
): CleanUpConfirmation {
  const dirty = selected.filter((candidate) => candidate.status.dirtyFiles > 0)
  const unpushed = selected.filter(
    (candidate) => candidate.status.dirtyFiles === 0 && candidate.status.unpushedCommits > 0
  )

  const lines = [`${count(selected.length, 'worktree')} in ${repositoryName} will be removed.`]

  if (unpushed.length > 0) {
    lines.push(
      '',
      `${count(unpushed.length, 'of them holds', 'of them hold')} commits that exist nowhere else. ` +
        'Their branches are kept, so the commits survive on those branches.'
    )
  }
  if (dirty.length > 0) {
    lines.push(
      '',
      `${count(dirty.length, 'has', 'have')} uncommitted changes and will be skipped — ` +
        'git refuses, and this flow does not force it.'
    )
  }

  lines.push('', 'Branches are never deleted here.')

  return {
    title: `Remove ${count(selected.length, 'worktree')} from ${repositoryName}?`,
    detail: lines.join('\n'),
    risky: dirty.length > 0 || unpushed.length > 0
  }
}

/** Outcome of one removal, so the summary can be honest about partial failure. */
export interface CleanUpOutcome {
  readonly label: string
  readonly removed: boolean
  readonly reason?: string
}

/**
 * What to tell the user afterwards. Failures are never rounded away — a bulk
 * action that silently skipped things would leave you believing the tree is
 * cleaner than it is.
 */
export function summariseCleanUp(outcomes: readonly CleanUpOutcome[]): string {
  const removed = outcomes.filter((outcome) => outcome.removed)
  const failed = outcomes.filter((outcome) => !outcome.removed)

  if (failed.length === 0) {
    return `Removed ${count(removed.length, 'worktree')}.`
  }
  if (removed.length === 0) {
    return `Removed nothing. ${failed.length === 1 ? failed[0].label : `${failed.length} worktrees`} could not be removed.`
  }
  return `Removed ${count(removed.length, 'worktree')}; ${failed.length} could not be removed.`
}

function count(value: number, singular: string, plural?: string): string {
  const noun = value === 1 ? singular : (plural ?? `${singular}s`)
  return `${value} ${noun}`
}
