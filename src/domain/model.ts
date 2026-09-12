/**
 * Domain model. Pure data and rules — no VS Code, no filesystem, no I/O.
 *
 * The convention this codifies, as found in ~/Code:
 *
 *   <root>/<repo>                      the main checkout        (.git is a directory)
 *   <root>/<repo>.worktrees/           container for its worktrees
 *   <root>/<repo>.worktrees/**​/        a worktree at any depth  (.git is a FILE)
 *
 * Nesting depth under `.worktrees` is arbitrary and carries no meaning: a worktree
 * on `feature/ABC-123-…` may live in a folder called plainly `ABC-123`. The branch
 * is therefore always read from git, never inferred from the path.
 */

/** Suffix marking a directory as a repository's worktree container. */
export const WORKTREES_SUFFIX = '.worktrees'

export interface Worktree {
  readonly absolutePath: string
  /** Path relative to the repository's `.worktrees` directory, e.g. `chore/dependabot-config-compliance`. */
  readonly folderPath: string
  /** Branch name, or undefined when HEAD is detached. */
  readonly branch?: string
  /** Short commit id, set only when HEAD is detached. */
  readonly detachedHead?: string
  /** True for the repository's primary checkout, which lives outside `.worktrees`. */
  readonly isMain: boolean
  /**
   * Claude Code sessions that have worked in this worktree, most recent first.
   * Empty for worktrees created by hand.
   */
  readonly claudeSessions: readonly ClaudeSession[]
}

export interface ClaudeSession {
  readonly id: string
  /** When the session attached, if the sidecar line carried a timestamp. */
  readonly at?: string
}

/**
 * Sidecar filenames inside `.git/worktrees/<name>/`, newest format first.
 *
 * The file is append-only, one `<session-id> <iso-8601>` record per line: a
 * comma-separated list would require read-modify-write, which loses entries when
 * two sessions start concurrently, whereas a short append does not.
 *
 * The legacy single-id file parses identically under the same line-based reader,
 * so no migration is needed.
 */
export const SESSION_SIDECARS = ['claude-sessions', 'claude-session'] as const

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parses sidecar contents into sessions, newest first. Unparseable lines are
 * dropped rather than shown, and a session repeated across lines keeps only its
 * most recent timestamp.
 */
export function parseSessions(contents: string): ClaudeSession[] {
  const byId = new Map<string, ClaudeSession>()

  for (const line of contents.split('\n')) {
    const [id, at] = line.trim().split(/\s+/)
    if (!id || !SESSION_ID_PATTERN.test(id)) {
      continue
    }
    const existing = byId.get(id)
    byId.set(id, { id, at: at ?? existing?.at })
  }

  return [...byId.values()].reverse()
}

export function latestSession(worktree: Worktree): ClaudeSession | undefined {
  return worktree.claudeSessions[0]
}

export interface Repository {
  readonly name: string
  readonly worktreesPath: string
  readonly worktrees: readonly Worktree[]
}

export interface Scan {
  readonly repositories: readonly Repository[]
  /**
   * Directories to watch non-recursively. Derived by the scanner rather than
   * assumed, so the watch set tracks the tree as it changes.
   */
  readonly watchPaths: readonly string[]
  /**
   * Directories watched for entries appearing or disappearing only.
   *
   * Claude transcript directories belong here: a live session rewrites its
   * transcript continuously, so reacting to content changes would mean rescanning
   * every few hundred milliseconds for the whole time you are chatting. Sessions
   * being created or deleted is the part worth noticing.
   */
  readonly sessionWatchPaths: readonly string[]
}

/** `widget-service.worktrees` → `widget-service`. Undefined if not a container. */
export function repositoryNameFor(directoryName: string): string | undefined {
  if (!directoryName.endsWith(WORKTREES_SUFFIX)) {
    return undefined
  }
  const name = directoryName.slice(0, -WORKTREES_SUFFIX.length)
  return name.length > 0 ? name : undefined
}

/** `ref: refs/heads/feature/ABC-123` → branch; a bare sha → detached. */
export function parseHead(headContents: string): Pick<Worktree, 'branch' | 'detachedHead'> {
  const text = headContents.trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text)
  if (ref) {
    return { branch: ref[1] }
  }
  return /^[0-9a-f]{7,40}$/i.test(text) ? { detachedHead: text } : {}
}

/** `gitdir: /path/to/.git/worktrees/foo` → the path. Undefined if not a worktree pointer. */
export function parseGitFile(gitFileContents: string): string | undefined {
  const match = /^gitdir:\s*(.+)$/m.exec(gitFileContents.trim())
  return match ? match[1].trim() : undefined
}

export function hasRealWorktrees(repository: Repository): boolean {
  return repository.worktrees.some((worktree) => !worktree.isMain)
}
