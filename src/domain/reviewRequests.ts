/**
 * Turning pull requests that want your review into worktrees. Pure — no GitHub
 * client, no git, no filesystem, no VS Code.
 *
 * This is the inverse of the panel's usual direction. Everywhere else, worktrees
 * are known and their pull requests are looked up; here the pull requests are
 * known and the worktrees do not exist yet.
 *
 * Deliberately not bot-specific. Dependabot dominates a review queue by volume,
 * but a colleague's pull request needs a checkout for exactly the same reason and
 * filtering by author would hide the ones that matter most.
 */
import { WORKTREES_SUFFIX } from './model'

/** A pull request awaiting your review, before anything local is known about it. */
export interface ReviewRequest {
  readonly repository: string
  readonly number: number
  readonly title: string
  readonly branch: string
  readonly url: string
  /** Login of whoever opened it. Bots report a bare login, e.g. `dependabot`. */
  readonly author?: string
  readonly createdAt?: string
}

/**
 * Whose review request counts.
 *
 * GitHub draws a line the obvious query does not: `review-requested:@me` includes
 * pull requests where a *team* you belong to was asked, `user-review-requested:@me`
 * only those naming you personally. Where CODEOWNERS routes reviews to squad
 * teams, the personal form matches nothing at all — so this is a choice, not a
 * detail to be guessed at.
 */
export type ReviewScope = 'team' | 'personal'

export const DEFAULT_REVIEW_SCOPE: ReviewScope = 'team'

export function reviewQualifier(scope: ReviewScope): string {
  return scope === 'personal' ? 'user-review-requested:@me' : 'review-requested:@me'
}

/** Search for open pull requests awaiting the signed-in user's review. */
export function reviewRequestQuery(organisation: string, scope: ReviewScope): string {
  return [
    'is:open',
    'is:pr',
    `org:${organisation}`,
    reviewQualifier(scope),
    // Archived repositories still return pull requests, and a worktree for one
    // cannot be pushed anywhere useful.
    'archived:false'
  ].join(' ')
}

/**
 * Why a pull request cannot be checked out, or `ready` when it can.
 *
 * `no-local-clone` is not an error to fix here — cloning a repository is a much
 * bigger act than adding a worktree, and doing it silently behind a checkbox
 * would be a surprise.
 */
export type CheckoutState = 'ready' | 'already-exists' | 'no-local-clone'

/** What is known locally about one pull request's repository. */
export interface LocalRepository {
  /** Absolute path of the main checkout, if it is cloned at `<root>/<repo>`. */
  readonly mainCheckout?: string
  /** True when a worktree for this branch is already on disk. */
  readonly worktreeExists: boolean
}

export interface CheckoutCandidate {
  readonly pullRequest: ReviewRequest
  readonly state: CheckoutState
  /** Where the worktree would go. Undefined when the repository is not cloned. */
  readonly targetPath?: string
  /** True when this one should start ticked. */
  readonly ready: boolean
  /** Why it is not ready, for the list. Undefined when it is. */
  readonly warning?: string
}

/**
 * The `.worktrees` container for a repository, from its main checkout.
 *
 * `~/Code/widget-service` → `~/Code/widget-service.worktrees`
 */
export function worktreesContainerFor(mainCheckout: string): string {
  return `${mainCheckout}${WORKTREES_SUFFIX}`
}

/**
 * Where a branch's worktree belongs under the convention.
 *
 * The branch name is used verbatim, so `dependabot/gradle/org.flywaydb-11.0.0`
 * nests three directories deep. That is deliberate: the convention places no
 * meaning on depth, and the alternative — flattening separators — would collide
 * two branches that differ only by where their slashes fall.
 */
export function worktreePathFor(mainCheckout: string, branch: string): string {
  return `${worktreesContainerFor(mainCheckout)}/${branch}`
}

/**
 * Decides what can be checked out, most recent pull request first.
 *
 * Nothing is filtered out: a pull request whose repository is not cloned still
 * appears, held back by its warning, because "why is that one missing" is a
 * worse question to leave the reader with than one unticked row.
 */
export function planCheckouts(
  pullRequests: readonly ReviewRequest[],
  local: (pullRequest: ReviewRequest) => LocalRepository
): CheckoutCandidate[] {
  const candidates = pullRequests.map((pullRequest) => {
    const { mainCheckout, worktreeExists } = local(pullRequest)

    if (!mainCheckout) {
      return {
        pullRequest,
        state: 'no-local-clone' as const,
        ready: false,
        warning: `${pullRequest.repository} is not cloned under the watched root`
      }
    }

    const targetPath = worktreePathFor(mainCheckout, pullRequest.branch)
    if (worktreeExists) {
      return {
        pullRequest,
        state: 'already-exists' as const,
        targetPath,
        ready: false,
        warning: 'a worktree for this branch already exists'
      }
    }

    return { pullRequest, state: 'ready' as const, targetPath, ready: true }
  })

  return candidates.sort(byNewestFirst)
}

function byNewestFirst(a: CheckoutCandidate, b: CheckoutCandidate): number {
  const at = a.pullRequest.createdAt ?? ''
  const bt = b.pullRequest.createdAt ?? ''
  return bt.localeCompare(at) || a.pullRequest.repository.localeCompare(b.pullRequest.repository)
}

/**
 * The login to show beside a pull request.
 *
 * GitHub's *search qualifier* for an app is `app/dependabot`, but the login it
 * returns on the pull request is the bare `dependabot`. The prefix is stripped
 * anyway so the two spellings cannot show up differently in one list.
 */
export function describeAuthor(author: string | undefined): string | undefined {
  if (!author) {
    return undefined
  }
  return author.replace(/^app\//, '')
}

/** Right-hand text in the list: which repo, which PR, who opened it, how old. */
export function candidateDescription(candidate: CheckoutCandidate, now: number): string {
  const { pullRequest } = candidate
  const parts = [`${pullRequest.repository} #${pullRequest.number}`]

  const author = describeAuthor(pullRequest.author)
  if (author) {
    parts.push(author)
  }

  const age = describeAgeOf(pullRequest.createdAt, now)
  if (age) {
    parts.push(age)
  }
  return parts.join('  ·  ')
}

function describeAgeOf(createdAt: string | undefined, now: number): string | undefined {
  if (!createdAt) {
    return undefined
  }
  const opened = Date.parse(createdAt)
  if (!Number.isFinite(opened)) {
    return undefined
  }
  const days = Math.floor((now - opened) / (24 * 60 * 60 * 1000))
  if (days <= 0) {
    return 'opened today'
  }
  return `${days} day${days === 1 ? '' : 's'} old`
}

/** Outcome of one checkout, so partial failure can be reported honestly. */
export interface CheckoutOutcome {
  readonly label: string
  readonly created: boolean
  readonly path?: string
  readonly reason?: string
}

export function summariseCheckouts(outcomes: readonly CheckoutOutcome[]): string {
  const created = outcomes.filter((outcome) => outcome.created)
  const failed = outcomes.filter((outcome) => !outcome.created)

  if (failed.length === 0) {
    return `Created ${count(created.length, 'worktree')}.`
  }
  if (created.length === 0) {
    return `Created nothing. ${count(failed.length, 'worktree')} could not be created.`
  }
  return `Created ${count(created.length, 'worktree')}; ${failed.length} failed.`
}

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`
}
