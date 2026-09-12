/**
 * TeamCity build domain. Pure — no HTTP, no auth, no VS Code.
 *
 * Two facts about TeamCity shape everything here:
 *
 * 1. **A branch is not one build.** One branch fans out across many build
 *    configurations (the monolith runs ~25: unit-test batches A–F, lint, jars,
 *    plus a composite). A single status therefore has to be rolled up.
 * 2. **Branch names collide across repositories.** Dependabot reuses identical
 *    branch names in every repo it touches, so a build only belongs to a worktree
 *    if its VCS root is that worktree's repository.
 */

export type BuildStatus = 'success' | 'failure' | 'running' | 'queued' | 'unknown'

export interface Build {
  readonly id: number
  /** TeamCity build configuration, e.g. `Gateway_Build`. */
  readonly buildTypeId: string
  /** Human name of the configuration, e.g. `Build`. */
  readonly buildTypeName?: string
  /** Environment project the configuration lives in, e.g. `WidgetService_Development`. */
  readonly projectId?: string
  readonly branch: string
  readonly status: BuildStatus
  readonly webUrl: string
  /** VCS root names this build checked out, used to attribute it to a repo. */
  readonly vcsRoots: readonly string[]
  readonly finishedAt?: string
  /** A composite build rolls up its dependencies, so it is the best summary. */
  readonly composite: boolean
}

export interface BranchBuilds {
  readonly repository: string
  readonly branch: string
  readonly status: BuildStatus
  /** Latest build per configuration, worst status first. */
  readonly builds: readonly Build[]
}

/** Failure dominates; then in-flight; success only when nothing else applies. */
const SEVERITY: Record<BuildStatus, number> = {
  failure: 0,
  running: 1,
  queued: 2,
  success: 3,
  unknown: 4
}

export function compareSeverity(a: BuildStatus, b: BuildStatus): number {
  return SEVERITY[a] - SEVERITY[b]
}

/**
 * True when a build checked out this repository.
 *
 * Matched on a path boundary so `api-gateway` does not also match
 * `api-gateway-2`; a build with no VCS root information is not attributed.
 */
export function buildBelongsTo(build: Build, repository: string): boolean {
  if (!repository) {
    return false
  }

  // The name must sit between separators: a plain substring test would let
  // `api` match `api-gateway`, attributing another repo's builds.
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const bounded = new RegExp(`(^|[/:\\s])${escaped}(\\.git)?($|[/:#?\\s])`, 'i')

  return build.vcsRoots.some(
    (root) => root.toLowerCase() === repository.toLowerCase() || bounded.test(root)
  )
}

/**
 * Reduces a branch's builds to one status.
 *
 * Only the newest build per configuration counts — a failure that was since
 * retried successfully is history, not current state. TeamCity returns builds
 * newest first, which is the order relied on here.
 */
export function rollUp(
  repository: string,
  branch: string,
  candidates: readonly Build[]
): BranchBuilds | undefined {
  const mine = candidates.filter((build) => buildBelongsTo(build, repository))
  if (mine.length === 0) {
    return undefined
  }

  const latestPerType = new Map<string, Build>()
  for (const build of mine) {
    if (!latestPerType.has(build.buildTypeId)) {
      latestPerType.set(build.buildTypeId, build)
    }
  }

  const builds = [...latestPerType.values()].sort(
    (a, b) => compareSeverity(a.status, b.status) || a.buildTypeId.localeCompare(b.buildTypeId)
  )

  return { repository, branch, status: builds[0].status, builds }
}

/** `Gateway_Build` → `Build`; used when TeamCity gives no display name. */
export function buildTypeLabel(build: Build): string {
  if (build.buildTypeName) {
    return build.buildTypeName
  }
  const tail = build.buildTypeId.split('_').slice(1).join(' ')
  return tail || build.buildTypeId
}

/** Short right-hand text: `build failed`, `build running`. */
export function buildSummary(branch: BranchBuilds): string | undefined {
  switch (branch.status) {
    case 'failure':
      return `${buildTypeLabel(branch.builds[0])} failed`
    case 'running':
      return 'build running'
    case 'queued':
      return 'build queued'
    case 'success':
      return 'build passed'
    default:
      return undefined
  }
}
