import { Activity } from '../domain/activity'
import { Emitter } from './emitter'
import { ActivityReader, ActivitySettings, Disposable, DirectoryWatcher, Logger } from './ports'

/** Transcript writes arrive in small bursts; coalesce before re-reading. */
const REFRESH_DEBOUNCE_MS = 400

export interface SessionRef {
  readonly sessionId: string
  readonly worktreePath: string
}

/**
 * Tracks what each recorded Claude session is currently doing.
 *
 * Event-driven, with no polling and no timers: a transcript is written roughly
 * once every twelve seconds during active work and not at all when a session is
 * idle, so watching for changes costs nothing while nothing is happening.
 *
 * Note this watches the same directories as the worktree scan, but for *content*
 * changes. The scan deliberately ignores those — a rescan walks the filesystem
 * and would be far too expensive to run on every transcript write, whereas
 * re-reading a 64KB tail is not.
 */
export class ActivityStore implements Disposable {
  private readonly changed = new Emitter<void>()
  readonly onDidChange = this.changed.on.bind(this.changed)

  private activities = new Map<string, Activity>()
  private sessions: readonly SessionRef[] = []
  private watchers?: Disposable
  private watchedKey = ''
  private debounce?: ReturnType<typeof setTimeout>
  private settingsListener?: Disposable
  private consumers = 0

  constructor(
    private readonly reader: ActivityReader,
    private readonly watcher: DirectoryWatcher,
    private readonly settings: ActivitySettings,
    private readonly logger: Logger
  ) {}

  find(sessionId: string): Activity | undefined {
    return this.activities.get(sessionId)
  }

  activate(): Disposable {
    if (++this.consumers === 1) {
      this.settingsListener = this.settings.onDidChange(() => this.rewatch())
      this.rewatch()
    }
    return {
      dispose: () => {
        if (--this.consumers === 0) {
          this.stop()
        }
      }
    }
  }

  /** Called after each scan with the sessions currently on disk. */
  setSessions(sessions: readonly SessionRef[]): void {
    this.sessions = sessions
    if (this.consumers > 0) {
      this.rewatch()
    }
  }

  dispose(): void {
    this.stop()
    this.changed.dispose()
  }

  private rewatch(): void {
    if (!this.settings.enabled) {
      if (this.activities.size > 0) {
        this.activities = new Map()
        this.changed.fire()
      }
      return
    }

    void this.refresh()
  }

  private scheduleRefresh(): void {
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS)
  }

  private async refresh(): Promise<void> {
    if (this.consumers === 0 || !this.settings.enabled) {
      return
    }

    const next = new Map<string, Activity>()
    const directories = new Set<string>()

    await Promise.all(
      this.sessions.map(async (session) => {
        const snapshot = await this.reader.read(session.sessionId)
        if (snapshot.directory) {
          directories.add(snapshot.directory)
        }
        if (snapshot.activity) {
          next.set(session.sessionId, snapshot.activity)
        }
      })
    )

    this.rewatchDirectories(directories)

    if (!sameActivities(this.activities, next)) {
      this.activities = next
      this.logger.info(`activity: ${next.size} session(s) reporting`)
      this.changed.fire()
    }
  }

  /**
   * Watch where the transcripts actually are. A session recorded against a
   * worktree may be running elsewhere, so the directory set comes from the files
   * that were read, not from the worktree paths.
   */
  private rewatchDirectories(directories: ReadonlySet<string>): void {
    const next = [...directories].sort().join('\n')
    if (next === this.watchedKey) {
      return
    }
    this.watchedKey = next
    this.watchers?.dispose()
    this.watchers = directories.size
      ? this.watcher.watch([...directories], () => this.scheduleRefresh())
      : undefined
  }

  private stop(): void {
    clearTimeout(this.debounce)
    this.debounce = undefined
    this.watchers?.dispose()
    this.watchers = undefined
    this.watchedKey = ''
    this.settingsListener?.dispose()
    this.settingsListener = undefined
  }
}

/** Avoids redrawing the tree when a transcript was touched but nothing changed. */
function sameActivities(a: ReadonlyMap<string, Activity>, b: ReadonlyMap<string, Activity>): boolean {
  if (a.size !== b.size) {
    return false
  }
  for (const [id, activity] of a) {
    const other = b.get(id)
    if (!other || other.label !== activity.label || other.at !== activity.at) {
      return false
    }
  }
  return true
}
