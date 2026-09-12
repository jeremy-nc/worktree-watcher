import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** Rebuilt at most this often; a full index takes about a millisecond. */
const TTL_MS = 5_000

/**
 * Maps a session id to its transcript file, wherever it lives.
 *
 * Transcripts sit under `~/.claude/projects/<cwd-as-slug>/<session-id>.jsonl`,
 * and it is tempting to derive the directory from the worktree being displayed.
 * That is wrong: a session recorded against a worktree has not necessarily *run*
 * there. The `/worktree` skill records the session that created a worktree, and
 * that session's transcript lives under whatever directory it was working in.
 *
 * Looking up by id instead makes no assumption about where a session ran.
 */
export class TranscriptIndex {
  private index = new Map<string, string>()
  private builtAt = 0
  private building?: Promise<void>

  constructor(private readonly projectsRoot: string) {}

  async locate(sessionId: string): Promise<string | undefined> {
    await this.ensureFresh()
    return this.index.get(sessionId)
  }

  async has(sessionId: string): Promise<boolean> {
    return (await this.locate(sessionId)) !== undefined
  }

  /** Empty when the projects directory is missing or unreadable. */
  async size(): Promise<number> {
    await this.ensureFresh()
    return this.index.size
  }

  /** Forget the cache — used after something is known to have changed. */
  invalidate(): void {
    this.builtAt = 0
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.builtAt < TTL_MS) {
      return
    }
    this.building ??= this.build().finally(() => {
      this.building = undefined
    })
    await this.building
  }

  private async build(): Promise<void> {
    const next = new Map<string, string>()
    try {
      const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true })
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const directory = path.join(this.projectsRoot, entry.name)
            try {
              for (const file of await fs.readdir(directory)) {
                if (file.endsWith('.jsonl')) {
                  next.set(file.slice(0, -'.jsonl'.length), path.join(directory, file))
                }
              }
            } catch {
              // A directory that vanished mid-scan is not an error.
            }
          })
      )
    } catch {
      // No projects directory: leave the index empty, callers treat that as
      // "cannot verify" rather than "nothing exists".
    }

    this.index = next
    this.builtAt = Date.now()
  }
}
