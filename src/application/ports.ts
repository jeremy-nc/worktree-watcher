/**
 * Ports — the interfaces the application layer depends on. Every one of these is
 * implemented in `infrastructure/` against VS Code or the filesystem, and can be
 * replaced by a fake in tests. Nothing here imports `vscode`.
 */
import { ClaudeSession, Scan } from '../domain/model'
import { BranchRef, PullRequest } from '../domain/pullRequest'
import { WorktreeStatus } from '../domain/removal'
import { Activity } from '../domain/activity'
import { ReviewScope } from '../domain/reviewRequests'
import { Build } from '../domain/build'

export interface Disposable {
  dispose(): void
}

export interface ScanOptions {
  readonly rootPath: string
  readonly maxDepth: number
}

export interface WorktreeScanner {
  scan(options: ScanOptions): Promise<Scan>
}

export interface DirectoryWatcher {
  /**
   * Watch each path for direct-child changes only. Implementations must not
   * recurse: the paths supplied are container directories, and recursing would
   * mean watching every file in every checked-out repository.
   */
  watch(paths: readonly string[], onChange: () => void): Disposable

  /** As `watch`, but ignoring content changes — only entries added or removed. */
  watchStructure(paths: readonly string[], onChange: () => void): Disposable
}

export interface Settings {
  readonly rootPath: string
  readonly maxDepth: number
  readonly showEmptyRepositories: boolean
  /** Idle days after which clean-up offers a worktree for removal. */
  readonly staleDays: number
  /** Whose review requests to list. */
  readonly reviewScope: ReviewScope
  onDidChange(listener: () => void): Disposable
}

/**
 * Drops recorded sessions that are not actually resumable.
 *
 * A session id firing SessionStart does not guarantee a resumable conversation —
 * some sessions start and never write a transcript, and `claude --resume` on one
 * of those fails. The filter has to happen on read: at SessionStart the
 * transcript does not exist yet, so the hook cannot know.
 *
 * Implementations must be conservative: drop a session only when it can be
 * positively shown to be dead, and return the input unchanged when verification
 * is impossible.
 */
export interface SessionVerifier {
  resumable(sessions: readonly ClaudeSession[]): Promise<readonly ClaudeSession[]>

  /** Directory whose contents determine which sessions exist for this worktree. */
  transcriptDirectory(worktreePath: string): string
}

/** Reads the titles Claude Code displays for sessions. */
export interface SessionTitleReader {
  titles(sessionIds: readonly string[]): Promise<Map<string, string>>
}

/** Reads pull request status for a set of branches. */
export interface PullRequestSource {
  /** False when the client is missing or unauthenticated — not an error. */
  available(): Promise<boolean>
  fetch(refs: readonly BranchRef[]): Promise<readonly PullRequest[]>
}

export interface GitHubSettings {
  readonly enabled: boolean
  readonly organisation: string
  readonly pollMinutes: number
  onDidChange(listener: () => void): Disposable
}

/**
 * Removes worktrees. Implementations must not force anything implicitly: git's
 * own refusals are the safety net and are surfaced for explicit confirmation.
 */
export interface WorktreeRemover {
  status(worktreePath: string): Promise<WorktreeStatus>
  /** Resolve before removing — afterwards the worktree directory is gone. */
  mainRepository(worktreePath: string): Promise<string>
  remove(mainRepository: string, worktreePath: string, force: boolean): Promise<void>
  deleteBranch(mainRepository: string, branch: string, force: boolean): Promise<void>
}

export interface ActivitySnapshot {
  readonly activity?: Activity
  /**
   * Directory holding the transcript that was actually read, so the store
   * watches where the session really is rather than where it was recorded.
   */
  readonly directory?: string
}

/** Reads what a session is doing from its transcript. */
export interface ActivityReader {
  read(sessionId: string): Promise<ActivitySnapshot>
}

export interface ActivitySettings {
  readonly enabled: boolean
  onDidChange(listener: () => void): Disposable
}

/** Reads build status from a CI server. */
export interface BuildSource {
  /** False when unconfigured or not signed in — not an error. */
  available(): Promise<boolean>
  buildsForBranch(branch: string): Promise<readonly Build[]>
}

export interface TeamCitySettings {
  readonly enabled: boolean
  readonly url: string
  readonly iapClientId: string
  readonly iapClientSecret: string
  /** Optional override when IAP expects an audience other than the client id. */
  readonly iapAudience: string
  /** Build configuration names the deploy button looks for, in order. */
  readonly deployBuildTypeNames: readonly string[]
  /** Environments the deploy button may target. Empty removes the guard. */
  readonly deployEnvironment: string
  readonly pollMinutes: number
  onDidChange(listener: () => void): Disposable
}

export interface Logger {
  info(message: string): void
  error(message: string, error?: unknown): void
}
