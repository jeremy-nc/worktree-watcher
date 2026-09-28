import { createHash, randomBytes } from 'node:crypto'
import { FSWatcher, promises as fs, watch } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Disposable, Logger, SharedCache } from '../application/ports'
import { CacheEntry } from '../domain/sharedCache'

/**
 * A lock older than this belongs to a window that died mid-fetch. Comfortably
 * longer than any source's request timeout, so a slow fetch is never mistaken
 * for a dead one.
 */
const LOCK_TTL_MS = 60_000

/**
 * Entries not rewritten for this long belong to branch sets that no longer
 * exist — keys include the branch list, so every worktree added or removed
 * retires one. Anything still in use is rewritten long before this.
 */
const ENTRY_RETENTION_MS = 24 * 60 * 60_000

/** Temporary and reclaimed files are abandoned if they survive this long. */
const DEBRIS_RETENTION_MS = 60 * 60_000

/** Writes this window made itself are not news to it. */
const OWN_WRITE_WINDOW_MS = 2_000
const CHANGE_DEBOUNCE_MS = 500

/**
 * The cross-window cache as a directory of JSON files, the same approach as
 * `PendingSessionStore`: a file is visible to every window immediately, survives
 * the writer closing, and can be inspected when something looks wrong.
 *
 * - **Writes are atomic.** Each goes to a temporary file and is renamed into
 *   place, so a reader sees the old value or the new one, never half of either.
 * - **Locks are exclusive creates** (`O_EXCL`), which the filesystem arbitrates.
 *   A lock whose holder died is reclaimed once it passes `LOCK_TTL_MS`.
 * - **Everything fails open**, as the `SharedCache` port requires.
 */
export class FileSharedCache implements SharedCache {
  private readonly ownWrites = new Map<string, number>()

  constructor(
    private readonly logger: Logger,
    private readonly directory: string = defaultDirectory()
  ) {}

  async read<T>(key: string): Promise<CacheEntry<T> | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.dataFile(key), 'utf8')) as {
        key?: unknown
        fetchedAt?: unknown
        value?: T
      }
      // The stored key is checked, not just the hashed filename, so a file
      // that somehow holds something else is ignored rather than served.
      if (parsed.key !== key || typeof parsed.fetchedAt !== 'number' || !('value' in parsed)) {
        return undefined
      }
      return { fetchedAt: parsed.fetchedAt, value: parsed.value as T }
    } catch {
      return undefined
    }
  }

  async write<T>(key: string, value: T, fetchedAt: number): Promise<void> {
    const target = this.dataFile(key)
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.mkdir(this.directory, { recursive: true })
      await fs.writeFile(temporary, JSON.stringify({ key, fetchedAt, value }), 'utf8')
      this.rememberOwnWrite(path.basename(target))
      await fs.rename(temporary, target)
    } catch (error) {
      this.logger.info(`shared cache: could not write ${key}: ${describe(error)}`)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async tryLock(key: string): Promise<boolean> {
    const lock = this.lockFile(key)
    try {
      await fs.mkdir(this.directory, { recursive: true })
    } catch {
      return true
    }

    if (await this.createLock(lock)) {
      return true
    }
    if (!(await this.reclaimIfStale(lock))) {
      return false
    }
    return this.createLock(lock)
  }

  async unlock(key: string): Promise<void> {
    await fs.rm(this.lockFile(key), { force: true }).catch(() => undefined)
  }

  async isLocked(key: string): Promise<boolean> {
    try {
      const { mtimeMs } = await fs.stat(this.lockFile(key))
      return Date.now() - mtimeMs < LOCK_TTL_MS
    } catch {
      return false
    }
  }

  /**
   * Calls `listener` when another window publishes something, so this one can
   * repaint without waiting for its own timer.
   *
   * Best effort by design: if the directory cannot be watched, windows still
   * converge on their next poll, which reads the same files.
   */
  onPeerWrite(listener: () => void): Disposable {
    let watcher: FSWatcher | undefined
    let debounce: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    void fs
      .mkdir(this.directory, { recursive: true })
      .then(() => {
        if (disposed) {
          return
        }
        watcher = watch(this.directory, (_event, filename) => {
          if (!filename || !filename.endsWith('.json') || this.isOwnWrite(filename)) {
            return
          }
          clearTimeout(debounce)
          debounce = setTimeout(listener, CHANGE_DEBOUNCE_MS)
        })
        watcher.on('error', (error) => {
          this.logger.info(`shared cache: watch stopped: ${describe(error)}`)
          watcher?.close()
        })
      })
      .catch((error) => this.logger.info(`shared cache: cannot watch: ${describe(error)}`))

    return {
      dispose: () => {
        disposed = true
        clearTimeout(debounce)
        watcher?.close()
      }
    }
  }

  private async createLock(lock: string): Promise<boolean> {
    try {
      const handle = await fs.open(lock, 'wx')
      await handle.writeFile(`${process.pid}\n`)
      await handle.close()
      return true
    } catch (error) {
      // Contention is the one failure that means "someone else has it".
      // Anything else means locking does not work here, so act alone.
      return (error as NodeJS.ErrnoException).code !== 'EEXIST'
    }
  }

  /**
   * Removes a lock left by a window that died mid-fetch.
   *
   * Claimed by renaming it aside first, so of two windows reclaiming at once
   * only one succeeds. The narrow race that remains — reclaiming a lock someone
   * re-created in between — costs at most a duplicate fetch, never wrong data.
   */
  private async reclaimIfStale(lock: string): Promise<boolean> {
    try {
      const { mtimeMs } = await fs.stat(lock)
      if (Date.now() - mtimeMs < LOCK_TTL_MS) {
        return false
      }
      const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`
      await fs.rename(lock, aside)
      await fs.rm(aside, { force: true })
      this.logger.info(`shared cache: reclaimed stale lock ${path.basename(lock)}`)
      return true
    } catch {
      // Gone already, or another window reclaimed it first — either way, try.
      return true
    }
  }

  /**
   * Deletes entries nobody has rewritten in a day, and debris from writes or
   * reclaims interrupted by a window closing. Safe to run from several windows
   * at once: removing a file another window already removed is not an error.
   */
  async prune(): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.directory)
    } catch {
      return
    }

    const now = Date.now()
    await Promise.all(
      names.map(async (name) => {
        const retention = name.endsWith('.json')
          ? ENTRY_RETENTION_MS
          : name.endsWith('.tmp') || name.includes('.stale-')
            ? DEBRIS_RETENTION_MS
            : undefined
        if (retention === undefined) {
          return
        }
        const file = path.join(this.directory, name)
        try {
          const { mtimeMs } = await fs.stat(file)
          if (now - mtimeMs > retention) {
            await fs.rm(file, { force: true })
          }
        } catch {
          // Removed by another window between readdir and stat.
        }
      })
    )
  }

  private rememberOwnWrite(filename: string): void {
    const now = Date.now()
    for (const [name, at] of this.ownWrites) {
      if (now - at >= OWN_WRITE_WINDOW_MS) {
        this.ownWrites.delete(name)
      }
    }
    this.ownWrites.set(filename, now)
  }

  private isOwnWrite(filename: string): boolean {
    const at = this.ownWrites.get(filename)
    return at !== undefined && Date.now() - at < OWN_WRITE_WINDOW_MS
  }

  private dataFile(key: string): string {
    return path.join(this.directory, `${hash(key)}.json`)
  }

  private lockFile(key: string): string {
    return path.join(this.directory, `${hash(key)}.lock`)
  }
}

/** Keys hold branch lists and URLs; hashing keeps filenames short and safe. */
function hash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 32)
}

function defaultDirectory(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state')
  return path.join(stateHome, 'worktree-watcher', 'cache')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
