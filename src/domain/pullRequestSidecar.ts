/**
 * What the extension leaves in a worktree's metadata about its pull request,
 * so the `/worktree-watcher-watch-review` skill can read it without GitHub.
 *
 * Lives at `.git/worktrees/<name>/worktree-watcher/pull-request.json`: git
 * removes it with the worktree, it never shows in `git status`, and it cannot
 * be committed. Pure; the writer and the scanner do the I/O.
 */
import {
  BotThreads,
  botThreadsOf,
  CheckState,
  PullRequest,
  PullRequestState,
  ReviewDecision,
  ReviewThread
} from './pullRequest'

/** Relative to git's per-worktree metadata directory. */
export const PULL_REQUEST_SIDECAR = 'worktree-watcher/pull-request.json'

export interface PullRequestSidecar {
  readonly repository: string
  readonly branch: string
  readonly url: string
  readonly number: number
  readonly title: string
  readonly state: PullRequestState
  readonly review?: ReviewDecision
  readonly checks?: CheckState
  /** Unresolved review threads opened by bots; what the watch script keys on. */
  readonly botThreads: number
  /** Those threads per bot login, so a row can be rebuilt from the file. */
  readonly bots: Readonly<Record<string, number>>
  /** ISO-8601 time of the poll that produced this. */
  readonly fetchedAt: string
}

export function toSidecar(
  pullRequest: PullRequest,
  extraBotLogins: readonly string[],
  fetchedAt: string
): PullRequestSidecar {
  const threads = botThreadsOf(pullRequest, extraBotLogins)
  return {
    repository: pullRequest.repository,
    branch: pullRequest.branch,
    url: pullRequest.url,
    number: pullRequest.number,
    title: pullRequest.title,
    state: pullRequest.state,
    ...(pullRequest.review && { review: pullRequest.review }),
    ...(pullRequest.checks && { checks: pullRequest.checks }),
    botThreads: threads.count,
    bots: perBot(threads),
    fetchedAt
  }
}

/** Equal in everything but when it was fetched, so an unchanged poll is not rewritten. */
export function sameSidecar(a: PullRequestSidecar, b: PullRequestSidecar): boolean {
  const { fetchedAt: _a, ...restA } = a
  const { fetchedAt: _b, ...restB } = b
  return JSON.stringify(restA) === JSON.stringify(restB)
}

const STATES: readonly PullRequestState[] = ['open', 'draft', 'merged', 'closed']

/** Reads a sidecar back, or undefined for anything that is not one. */
export function parseSidecar(text: string): PullRequestSidecar | undefined {
  let raw: Partial<PullRequestSidecar>
  try {
    raw = JSON.parse(text) as Partial<PullRequestSidecar>
  } catch {
    return undefined
  }
  if (
    typeof raw.repository !== 'string' ||
    typeof raw.branch !== 'string' ||
    typeof raw.url !== 'string' ||
    typeof raw.number !== 'number' ||
    typeof raw.fetchedAt !== 'string' ||
    !STATES.includes(raw.state as PullRequestState)
  ) {
    return undefined
  }
  const bots = typeof raw.bots === 'object' && raw.bots !== null ? raw.bots : {}
  return {
    repository: raw.repository,
    branch: raw.branch,
    url: raw.url,
    number: raw.number,
    title: typeof raw.title === 'string' ? raw.title : '',
    state: raw.state as PullRequestState,
    ...(raw.review && { review: raw.review }),
    ...(raw.checks && { checks: raw.checks }),
    botThreads: typeof raw.botThreads === 'number' ? raw.botThreads : 0,
    bots,
    fetchedAt: raw.fetchedAt
  }
}

/**
 * The pull request a sidecar describes, for a row to show before the first
 * poll answers. Its threads are rebuilt from the per-bot counts, which is all
 * the row needs; the live poll replaces them.
 */
export function pullRequestFromSidecar(sidecar: PullRequestSidecar): PullRequest {
  const threads: ReviewThread[] = []
  for (const [login, count] of Object.entries(sidecar.bots)) {
    for (let index = 0; index < count; index++) {
      threads.push({ resolved: false, author: { login, isBot: true } })
    }
  }
  return {
    repository: sidecar.repository,
    branch: sidecar.branch,
    number: sidecar.number,
    title: sidecar.title,
    url: sidecar.url,
    state: sidecar.state,
    review: sidecar.review,
    checks: sidecar.checks,
    updatedAt: sidecar.fetchedAt,
    threads
  }
}

function perBot(threads: BotThreads): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const login of threads.byLogin.keys()) {
    counts[login] = threads.byLogin.get(login) ?? 0
  }
  return counts
}
