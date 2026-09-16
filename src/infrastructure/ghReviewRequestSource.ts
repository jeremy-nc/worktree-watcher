import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ReviewRequest, ReviewScope, reviewRequestQuery } from '../domain/reviewRequests'

const run = promisify(execFile)
const REQUEST_TIMEOUT_MS = 30_000

/** GitHub's search API caps a page at 100, which is far beyond a review queue. */
const PAGE_SIZE = 100

/**
 * Finds open pull requests awaiting the signed-in user's review.
 *
 * Separate from {@link ./ghPullRequestSource.ts} on purpose. That one starts from
 * worktrees and looks up their pull requests; this starts from pull requests that
 * have no worktree yet. Sharing a query would mean one of them asking GitHub a
 * question it does not want the answer to.
 *
 * Runs on demand rather than on the poll timer: it is a click, and a review queue
 * that refreshes itself in the background would be a notification, which this
 * panel is not.
 */
export class GhReviewRequestSource {
  constructor(
    private readonly organisation: string,
    private readonly scope: ReviewScope
  ) {}

  async fetch(): Promise<readonly ReviewRequest[]> {
    if (!this.organisation) {
      return []
    }

    const { stdout } = await run(
      'gh',
      [
        'api',
        'graphql',
        '-f',
        `q=${reviewRequestQuery(this.organisation, this.scope)}`,
        '-f',
        `query=${SEARCH}`
      ],
      { timeout: REQUEST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    )

    const payload = JSON.parse(stdout) as {
      data?: { search?: { nodes?: RawPullRequest[] } }
    }

    return (payload.data?.search?.nodes ?? [])
      .map(toPullRequest)
      .filter((pullRequest): pullRequest is ReviewRequest => pullRequest !== undefined)
  }
}

const SEARCH = `query($q: String!) {
  search(query: $q, type: ISSUE, first: ${PAGE_SIZE}) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        headRefName
        createdAt
        author { login }
        repository { name }
      }
    }
  }
}`

interface RawPullRequest {
  number?: number
  title?: string
  url?: string
  headRefName?: string
  createdAt?: string
  author?: { login?: string } | null
  repository?: { name?: string }
}

function toPullRequest(node: RawPullRequest): ReviewRequest | undefined {
  if (
    typeof node.number !== 'number' ||
    !node.headRefName ||
    !node.url ||
    !node.repository?.name
  ) {
    return undefined
  }
  return {
    repository: node.repository.name,
    number: node.number,
    title: node.title ?? '',
    branch: node.headRefName,
    url: node.url,
    author: node.author?.login,
    createdAt: node.createdAt
  }
}
