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
  /** True when GitHub typed the author as a Bot rather than a User. */
  readonly authorIsBot?: boolean
  readonly isDraft?: boolean
  readonly createdAt?: string
}

/** Codicon marking who opened a pull request, so bots read at a glance. */
export function authorIcon(pullRequest: ReviewRequest): string {
  return pullRequest.authorIsBot ? '$(robot)' : '$(account)'
}

/**
 * Whose review request counts.
 *
 * GitHub draws a line the obvious query does not: `review-requested:@me` includes
 * pull requests where *any team* you belong to was asked, `user-review-requested:@me`
 * only those naming you personally.
 *
 * The gap is not marginal. Belonging to one broad team — a `cloud-services` that
 * CODEOWNERS names on most repositories — means the team-inclusive form returns
 * the whole squad's queue, not yours.
 */
export type ReviewScope = 'team' | 'personal'

/**
 * Personal by default, which is the opposite of what it looks like it should be.
 *
 * Measured on this organisation: the team-inclusive form returns 33 pull
 * requests, 28 of them requested from one broad team. The personal form returns
 * the 5 that actually name you. A list where six in seven rows are someone
 * else's problem is a list nobody reads.
 */
export const DEFAULT_REVIEW_SCOPE: ReviewScope = 'personal'

export function reviewQualifier(scope: ReviewScope): string {
  return scope === 'personal' ? 'user-review-requested:@me' : 'review-requested:@me'
}

export interface QueryOptions {
  readonly scope: ReviewScope
  /** Drop pull requests still marked draft. */
  readonly excludeDrafts: boolean
  /** Drop pull requests you have already reviewed. */
  readonly excludeReviewed: boolean
}

/**
 * Search for open pull requests awaiting the signed-in user's review.
 *
 * `-reviewed-by:@me` is close to a no-op in normal use, because submitting a
 * review clears your pending request — the two sets barely overlap. It earns its
 * place in the one case where they do: a review re-requested after you had
 * already looked, which is otherwise indistinguishable from a fresh one.
 */
export function reviewRequestQuery(organisation: string, options: QueryOptions): string {
  const parts = [
    'is:open',
    'is:pr',
    `org:${organisation}`,
    reviewQualifier(options.scope),
    // Archived repositories still return pull requests, and a worktree for one
    // cannot be pushed anywhere useful.
    'archived:false'
  ]
  if (options.excludeDrafts) {
    parts.push('draft:false')
  }
  if (options.excludeReviewed) {
    parts.push('-reviewed-by:@me')
  }
  return parts.join(' ')
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

/**
 * Header text for the panel: `5 PRs awaiting review`.
 *
 * Undefined at zero, which removes it rather than printing a nought. An empty
 * queue is the normal state and does not need announcing.
 */
export function describeReviewQueue(count: number): string | undefined {
  if (count <= 0) {
    return undefined
  }
  return `${count} PR${count === 1 ? '' : 's'} awaiting review`
}

/**
 * Default opening message. `${url}`, `${repository}`, `${branch}` and `${number}`
 * are substituted.
 */
export const DEFAULT_SESSION_PROMPT =
  'Pull ${url} (${repository}, branch ${branch}) following the worktree conventions.'

/**
 * The opening message for a session started against a pull request.
 *
 * The URL does double duty: it tells Claude which pull request this is, and it
 * is the marker that later identifies the session as belonging to this one. So
 * a template that leaves it out gets it appended — a customised prompt should
 * change the wording, not quietly break the ability to find the session again.
 *
 * Branch names cannot serve as that marker: Dependabot opens identically named
 * branches in every repository it touches, so a branch would match the wrong
 * repository's session.
 */
export function botSessionPrompt(
  pullRequest: ReviewRequest,
  template: string = DEFAULT_SESSION_PROMPT
): string {
  const filled = fillTemplate(template.trim() || DEFAULT_SESSION_PROMPT, pullRequest)
  return filled.includes(pullRequest.url) ? filled : `${filled} — ${pullRequest.url}`
}

function fillTemplate(template: string, pullRequest: ReviewRequest): string {
  const values: Record<string, string> = {
    url: pullRequest.url,
    repository: pullRequest.repository,
    branch: pullRequest.branch,
    number: String(pullRequest.number),
    title: pullRequest.title
  }
  // An unknown placeholder is left as written rather than blanked, so a typo is
  // visible in the prompt instead of silently losing text.
  return template.replace(/\$\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole)
}

/**
 * What the bot-workspace button says before you press it.
 *
 * The worktree rows know their sessions from the scan, so their button only
 * exists when there is something to resume. These rows are told the same thing,
 * with one honest difference: the workspace is shared, so these sessions belong
 * to the **directory**, not to this pull request. The wording names the
 * directory so that cannot be mistaken.
 */
export function botSessionTooltip(options: {
  readonly count: number
  readonly latestTitle?: string
  readonly workspace: string
}): string {
  const { count, latestTitle, workspace } = options
  if (count === 0) {
    return `Start a Claude session for this pull request in ${workspace}`
  }

  const named = latestTitle ? `“${latestTitle}”` : 'its session'
  const others = count === 1 ? '' : ` — ${count} for this pull request`
  return `Resume ${named} in ${workspace}${others}`
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
