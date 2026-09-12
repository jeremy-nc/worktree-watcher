import { compareRepositories, compareWorktrees } from '../domain/display'
import { hasRealWorktrees, Repository } from '../domain/model'
import { Emitter } from './emitter'
import { Disposable, DirectoryWatcher, Logger, Settings, WorktreeScanner } from './ports'

/** Filesystem events arrive in bursts; coalesce before rescanning. */
const RESCAN_DEBOUNCE_MS = 400

export interface State {
  readonly status: 'idle' | 'scanning' | 'ready' | 'error'
  readonly repositories: readonly Repository[]
  readonly scannedAt?: number
  readonly error?: string
}

/**
 * Orchestration. Owns the scan lifecycle, the watch set, debouncing and caching,
 * and publishes immutable state. Depends only on ports, so it is driven entirely
 * by fakes in tests.
 */
export class WorktreeStore implements Disposable {
  private readonly changed = new Emitter<State>()
  readonly onDidChange = this.changed.on.bind(this.changed)

  private state: State = { status: 'idle', repositories: [] }
  private watchers?: Disposable
  private debounce?: ReturnType<typeof setTimeout>
  private settingsListener?: Disposable
  private activeScan = 0
  private consumers = 0

  constructor(
    private readonly scanner: WorktreeScanner,
    private readonly watcher: DirectoryWatcher,
    private readonly settings: Settings,
    private readonly logger: Logger
  ) {}

  get current(): State {
    return this.state
  }

  /**
   * Register interest. Scanning and watching start with the first consumer and
   * stop when the last disposes, so a hidden view costs nothing.
   */
  activate(): Disposable {
    if (++this.consumers === 1) {
      this.settingsListener = this.settings.onDidChange(() => this.rescan())
      void this.rescan()
    }
    return {
      dispose: () => {
        if (--this.consumers === 0) {
          this.stop()
        }
      }
    }
  }

  refresh(): void {
    if (this.consumers > 0) {
      void this.rescan()
    }
  }

  dispose(): void {
    this.stop()
    this.changed.dispose()
  }

  private async rescan(): Promise<void> {
    const token = ++this.activeScan
    this.publish({ ...this.state, status: 'scanning' })

    try {
      const scan = await this.scanner.scan({
        rootPath: this.settings.rootPath,
        maxDepth: this.settings.maxDepth
      })
      if (token !== this.activeScan) {
        return
      }

      const repositories = scan.repositories
        .filter((repository) => this.settings.showEmptyRepositories || hasRealWorktrees(repository))
        .map((repository) => ({
          ...repository,
          worktrees: [...repository.worktrees].sort(compareWorktrees)
        }))
        .sort(compareRepositories)

      this.rewatch(scan.watchPaths, scan.sessionWatchPaths)
      this.publish({ status: 'ready', repositories, scannedAt: Date.now() })
    } catch (error) {
      if (token !== this.activeScan) {
        return
      }
      this.logger.error('Worktree scan failed', error)
      // Keep the last good repositories: a stale tree beats an empty one.
      this.publish({ ...this.state, status: 'error', error: describe(error) })
    }
  }

  /** The watch set changes as worktrees come and go, so it is rebuilt per scan. */
  private rewatch(paths: readonly string[], sessionPaths: readonly string[]): void {
    this.watchers?.dispose()
    const full = this.watcher.watch(paths, () => this.scheduleRescan())
    const structure = this.watcher.watchStructure(sessionPaths, () => this.scheduleRescan())
    this.watchers = {
      dispose: () => {
        full.dispose()
        structure.dispose()
      }
    }
  }

  private scheduleRescan(): void {
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.rescan(), RESCAN_DEBOUNCE_MS)
  }

  private publish(state: State): void {
    this.state = state
    this.changed.fire(state)
  }

  private stop(): void {
    clearTimeout(this.debounce)
    this.debounce = undefined
    this.watchers?.dispose()
    this.watchers = undefined
    this.settingsListener?.dispose()
    this.settingsListener = undefined
    this.activeScan++
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
