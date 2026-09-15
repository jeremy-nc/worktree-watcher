import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { PullRequestSource } from '../application/ports'
import {
  BranchRef,
  CheckState,
  PullRequest,
  PullRequestState,
  ReviewDecision,
  ReviewState,
  resolveReview
} from '../domain/pullRequest'

const run = promisify(execFile)

/** GitHub search caps qualifier terms; stay well inside it per repository. */
const MAX_BRANCHES_PER_REPOSITORY = 40

/** A slow network call should not hold a poll open indefinitely. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Reads pull request status through the `gh` CLI.
 *
 * Auth and transport ride `gh`'s own keyring token, so there is no token to
 * store, refresh or leak into settings — the same approach terminal-project's
 * `github/pulls` service takes.
 *
 * All branches are fetched in **one** GraphQL call: one aliased search per
 * repository, with the worktree branches as `head:` terms, which GitHub ORs
 * within a query. That keeps a poll at a single request no matter how many
 * worktrees exist.
 */
export class GhPullRequestSource implements PullRequestSource {
  constructor(private readonly organisation: string) {}

  async available(): Promise<boolean> {
    try {
      await run('gh', ['auth', 'status'], { timeout: REQUEST_TIMEOUT_MS })
      return true
    } catch {
      return false
    }
  }

  async fetch(refs: readonly BranchRef[]): Promise<readonly PullRequest[]> {
    const query = buildQuery(refs, this.organisation)
    if (!query) {
      return []
    }

    const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=${query.text}`], {
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    })

    return parseResponse(stdout, query.repositoriesByAlias)
  }
}

export interface BuiltQuery {
  readonly text: string
  readonly repositoriesByAlias: ReadonlyMap<string, string>
}

/**
 * Builds the aliased GraphQL search. Pure and exported so the query shape can be
 * tested without touching the network.
 */
export function buildQuery(
  refs: readonly BranchRef[],
  organisation: string
): BuiltQuery | undefined {
  // Unconfigured until the user names their org. Building the search anyway
  // would ask GitHub for `repo:/name`, which is not a repository.
  if (!isSafeRef(organisation)) {
    return undefined
  }

  const byRepository = new Map<string, string[]>()
  for (const ref of refs) {
    if (!isSafeRef(ref.repository) || !isSafeRef(ref.branch)) {
      continue
    }
    byRepository.set(ref.repository, [...(byRepository.get(ref.repository) ?? []), ref.branch])
  }
  if (byRepository.size === 0) {
    return undefined
  }

  const repositoriesByAlias = new Map<string, string>()
  const searches: string[] = []

  for (const [repository, branches] of byRepository) {
    const alias = `r${repositoriesByAlias.size}`
    repositoriesByAlias.set(alias, repository)

    const heads = [...new Set(branches)]
      .slice(0, MAX_BRANCHES_PER_REPOSITORY)
      .map((branch) => `head:${branch}`)
      .join(' ')

    searches.push(
      `  ${alias}: search(query: "is:pr repo:${organisation}/${repository} ${heads}", ` +
        `type: ISSUE, first: ${MAX_BRANCHES_PER_REPOSITORY}) { ...prFields }`
    )
  }

  const text = `query {\n${searches.join('\n')}\n}\n${PR_FRAGMENT}`
  return { text, repositoriesByAlias }
}

const PR_FRAGMENT = `fragment prFields on SearchResultItemConnection {
  nodes {
    ... on PullRequest {
      number
      title
      url
      state
      isDraft
      headRefName
      updatedAt
      reviewDecision
      # The most recent review per reviewer. Needed because reviewDecision is
      # null on repositories with no required-review rule, however many
      # approvals a pull request has.
      latestReviews(first: 20) { nodes { state } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`

/**
 * Branch and repository names go into a GraphQL string literal and a GitHub
 * search query, so anything that could break out of either is dropped rather
 * than escaped. Git refs never legitimately contain these characters.
 */
function isSafeRef(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9._\-/]+$/.test(value)
}

function parseResponse(
  stdout: string,
  repositoriesByAlias: ReadonlyMap<string, string>
): PullRequest[] {
  const payload = JSON.parse(stdout) as {
    data?: Record<string, { nodes?: RawPullRequest[] } | undefined>
    errors?: unknown
  }

  if (payload.errors) {
    throw new Error(`GitHub returned errors: ${JSON.stringify(payload.errors).slice(0, 200)}`)
  }

  const found: PullRequest[] = []
  for (const [alias, result] of Object.entries(payload.data ?? {})) {
    const repository = repositoriesByAlias.get(alias)
    if (!repository || !result?.nodes) {
      continue
    }
    for (const node of result.nodes) {
      const pullRequest = toPullRequest(node, repository)
      if (pullRequest) {
        found.push(pullRequest)
      }
    }
  }
  return found
}

interface RawPullRequest {
  number?: number
  title?: string
  url?: string
  state?: string
  isDraft?: boolean
  headRefName?: string
  updatedAt?: string
  reviewDecision?: string | null
  latestReviews?: { nodes?: Array<{ state?: string } | null> | null } | null
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> }
}

function toPullRequest(node: RawPullRequest, repository: string): PullRequest | undefined {
  if (typeof node.number !== 'number' || !node.headRefName || !node.url) {
    return undefined
  }
  return {
    repository,
    branch: node.headRefName,
    number: node.number,
    title: node.title ?? '',
    url: node.url,
    state: toState(node.state, node.isDraft === true),
    checks: toChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    review: resolveReview(
      toReview(node.reviewDecision),
      (node.latestReviews?.nodes ?? [])
        .map((review) => toReviewState(review?.state))
        .filter((state): state is ReviewState => state !== undefined)
    ),
    updatedAt: node.updatedAt
  }
}

/** Draft is a separate flag on an OPEN pull request, but reads as its own state. */
function toState(state: string | undefined, isDraft: boolean): PullRequestState {
  switch (state) {
    case 'MERGED':
      return 'merged'
    case 'CLOSED':
      return 'closed'
    default:
      return isDraft ? 'draft' : 'open'
  }
}

function toChecks(state: string | undefined): CheckState | undefined {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
      return 'failure'
    case 'ERROR':
      return 'error'
    case 'PENDING':
      return 'pending'
    default:
      return undefined
  }
}

function toReviewState(state: string | null | undefined): ReviewState | undefined {
  switch (state) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes-requested'
    case 'COMMENTED':
      return 'commented'
    case 'DISMISSED':
      return 'dismissed'
    case 'PENDING':
      return 'pending'
    default:
      return undefined
  }
}

function toReview(decision: string | null | undefined): ReviewDecision | undefined {
  switch (decision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes-requested'
    case 'REVIEW_REQUIRED':
      return 'review-required'
    default:
      return undefined
  }
}
